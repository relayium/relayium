#!/usr/bin/env node
// scripts/test/ci-event-policy-test.mjs — the trigger, concurrency and race-lane
// policy that nothing in GitHub Actions can check for itself.
//
// ## What went wrong, twice
//
// 1. Every workflow here listened to `push` with no branch filter AND to
//    `pull_request`. A branch with an open PR therefore ran each workflow
//    TWICE per commit against an identical tree — including a ~44 minute race
//    lane. Nothing reports that: both runs are green, and the duplicate is
//    only visible if you count the runs.
//
// 2. The obvious concurrency fix, `group: <workflow>-${{ github.ref }}`, is
//    actively unsafe. GitHub cancels an older PENDING run in a group when a
//    newer one arrives, and it does that even with `cancel-in-progress: false`.
//    Two merges in quick succession put two `main` runs in one `refs/heads/main`
//    group and the first is cancelled — so a commit that was never verified
//    shows a *cancelled* check rather than a missing or failed one, which reads
//    as "someone stopped it" rather than "this is untested".
//
// The rule that satisfies both: group by PR NUMBER when there is one, and by
// `github.run_id` — unique per run — for everything else. Then a PR supersedes
// only itself and nothing can ever cancel a `main`, dispatch or scheduled run.
//
// ## And the race lane
//
// `go.yml`'s race gate was one `go test -race -timeout 45m ./...` measured at
// ~43m35s, i.e. a lane that expires before it detects. It is now an eight-way
// shard matrix over `server/account` plus one job for every other package, and
// the full serial run moved to a non-gating nightly workflow so ordering
// defects stay visible. Each of those pieces is individually deletable without
// breaking any YAML: drop the matrix and one shard's tests silently stop being
// race-checked; add a retry and a real race becomes a rerun; give the nightly a
// `pull_request:` trigger and the 44-minute gate is back.
//
// Every one of those is asserted below, because all of them leave the workflow
// syntactically valid — no YAML check, and no linter GitHub runs, would object
// to any of them — and the next signal would be a race reaching production.
//
// ## And the platform boundary
//
// Section 6 governs which workflow owns which platform, which is the same class
// of invisible property one level up. `apps/mac/**` belongs to `macos.yml` and
// `apps/ios/**` to `ios.yml`; `apps/RelayiumKit/**` is APPLE-SHARED and fans out
// to both on purpose; `compat.yml` is the always-on, unfiltered wire-
// compatibility gate every platform must pass. The failure mode is not a broken
// build but an inherited one: a coarse `apps/**` or `scripts/**` filter silently
// adopts the next platform root the day somebody creates it, so a future
// `apps/android/` change would start a macOS runner that builds nothing it
// touched — exactly what `apps/**` did to iOS before the native split. The
// checks are written against COMPILED GLOBS rather than against the literal
// lists, so "too broad" and "too narrow" fail the same way, and section 8 mutates
// the parsed workflows to prove each of them can actually fail.
//
// `docs/CI-PLATFORM-BOUNDARY.md` states the boundary in prose. This file is what
// makes it true.
//
// ## And the paid-runner budget
//
// Section 6i governs the most expensive lanes — `ios.yml`, `release.yml` and,
// since the macOS split, `macos-release.yml` — against two failures that leave
// the YAML perfectly valid. A job with no
// `timeout-minutes` inherits GitHub's SIX-HOUR default, so one wedged run holds
// a paid macOS runner — or a release job with the signing key on disk — for six
// hours instead of turning the board red in minutes; both files had no timeout
// at all. And `ios.yml` honoured a `[macos-only]` marker in a `main` commit
// message, which let a commit message skip the iOS build: a skipped check does
// not report red, it reports nothing, so the skip was invisible in the merge box
// on the one branch where this workflow is the only thing that compiles iOS.
// Both are fixed, and both are asserted here — including the GENERAL shape of
// the escape, so it cannot return as `[skip-ios]` or any other spelling.
//
// ## And the CI/release boundary
//
// Section 6m governs the newest one, and it is the only section here about a
// boundary between two FILES. `macos.yml` used to be both the workflow that runs
// on every push and pull request AND the workflow holding `contents: write`, a
// `gh release create`, a `git push origin …:main`, an Apple notary key and the
// Sparkle private signing key. What separated an ordinary pull request from an
// immutable public release was a job-level `if:` — correct, and one edit from
// not being there.
//
// It is now two files: `macos.yml` is a read-only reusable CALLEE with no
// release operation in it at all, and `macos-release.yml` is the sole manual
// entry point, the sole holder of `contents: write`, and the caller. Section 6m
// asserts the exact input, secret, output, job, permission and `needs` shape of
// both, that the notarization job downloads the artifact the build NAMED behind
// a guard against that name being empty, and that no release operation is
// reachable with every input at its default. Section 2 gained the concurrency
// half of the same split: a reusable callee may not key its group on `${{
// github.workflow }}`, which inside a called workflow is the CALLER's name and
// deadlocks the two against each other.
//
// ## And the name the required check is required BY
//
// Section 6j is the one property of `main`'s branch protection that source can
// hold up its half of. Protection now requires exactly one context — the
// aggregate's `merge-gate` job — and the `app_id` 15368 binding stops a
// differently-owned check of the same name from satisfying it.
//
// The job name `wire-vectors` is still pinned there, and dropping the direct
// `pull_request:` trigger from `compat.yml` did not stop it mattering. It is
// half of `compat / wire-vectors`, the context the aggregate consumes as its
// `compat` lane, and it is the whole of the bare `wire-vectors` check run that
// `compat.yml`'s permanent `push: main` trigger puts on a `main` commit —
// which `relayium-ops`' `deploy/promote.sh` reads before it promotes. Neither
// the `app_id` binding nor any settings read-back can see a SECOND job named
// `wire-vectors` in this repository: that is the same app posting the same
// context, so an unrelated green lane can stand in for the contract gate.
// Section 6j therefore asserts, across every workflow file on disk rather than
// only the governed ones, that `compat.yml` still declares that job and that
// nothing else declares it.
//
// ## Why the YAML parser is written out here, and what checks IT
//
// Same reason as macos-publish-order-test.mjs and native-web-pairing-gate-test.mjs:
// `web/` is the only Node project in this repository, and a guard that runs on
// every pull request must not need `npm ci` first. The parser below covers the
// subset these workflows use and throws on anything it does not understand,
// rather than guessing.
//
// A hand-written parser is the one thing here that could make every policy
// check below pass vacuously: mis-read a workflow, get `undefined` where the
// policy expected a value, and the assertions are testing the parser's failure
// rather than the workflow. Two things guard against that, and both run every
// time this file does:
//
//  1. `assertParserReadsTheWorkflowSubset()` parses an embedded fixture that
//     exercises every construct these governed workflows use — block mappings and
//     sequences, inline sequences, `|` and `>-` block scalars, anchors and
//     aliases, quoted values containing `#`, and the `on:` key surviving as the
//     string "on" rather than YAML 1.1's boolean — and asserts the exact
//     resulting object.
//  2. `assertParseWasNotVacuous()` requires each governed workflow to have come
//     out with a non-empty `on`, `jobs` and `concurrency`, so a parse that
//     silently produced an empty document cannot read as a policy pass.
//
// There is deliberately no second, real YAML implementation in the loop. This
// guard gates every pull request, and giving it a Python or npm dependency to
// install first would trade a checkable risk for an outage that blocks merges.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { PATH_MATRIX } from "./fixtures/ci-path-selection.mjs";
import { CONTROL_FILES as SELECTOR_CONTROL_FILES, LANES as SELECTOR_LANES } from "../ci/select-lanes.mjs";
import { adopt as adoptText, fullPathText } from "../ci/ci-evidence-view.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const workflowsDir = resolve(repoRoot, ".github/workflows");

// ── the policy, stated once ─────────────────────────────────────────────────

/**
 * The workflows this policy binds, and the exact TRIGGER SHAPE each is expected
 * to have. Naming them explicitly is the point: a workflow silently dropped
 * from this list would stop being checked, so the list is the assertion.
 *
 * Three fields, and the last two are the aggregate merge gate stated as data:
 *
 *   `dispatch`  a manual `workflow_dispatch:` is expected.
 *   `call`      this file is a reusable CALLEE. `merge-gate.yml` calls it, and
 *               that call is now the ONLY way a pull request reaches it.
 *   `directPr`  this file still carries its own `pull_request:` trigger.
 *
 * `call` and `directPr` are opposites on every lane, with no exception left.
 * `compat.yml` was the one file with BOTH, and that was a fact about the
 * migration rather than a rule: while the bare `wire-vectors` was a required
 * context, removing compat's direct trigger in the change that added
 * `workflow_call:` would have left that context reported by no run at all, and
 * an ABSENT required context blocks every pull request rather than failing one.
 * Protection edit B made `merge-gate` the sole required context, the direct
 * trigger went with it, and the row below now reads `directPr: false` like
 * every other. Section 6o binds what compat may not grow back.
 *
 * On EVERY lane, compat included, a `pull_request:` reappearing is a lane
 * running TWICE per commit with nothing paying for it — once directly, once
 * through the gate — which is exactly the duplicate this repository removed
 * once already.
 */
const GOVERNED = [
  { file: "go.yml", dispatch: true, call: true, directPr: false },
  // `dispatch: false`, and that is the whole macOS CI/release split stated in
  // one field. This file is the reusable CI CALLEE: it runs on every push to
  // `main` and every pull request, and it is started manually by nothing. Every
  // reason to start it by hand was a release reason, and release moved to
  // `macos-release.yml` — which is deliberately absent from this list, because
  // it has no `push` and no `pull_request` and section 1 would assert things
  // about it that must not be true. Section 6m binds it instead, and section 6i
  // budgets it.
  //
  // A `workflow_dispatch:` reappearing here fails this entry AND section 6m: it
  // is where the five release inputs and the jobs that read them came back
  // from.
  { file: "macos.yml", dispatch: false, call: true, directPr: false },
  { file: "ios.yml", dispatch: true, call: true, directPr: false },
  { file: "ios-transfer-interop.yml", dispatch: true, call: true, directPr: false },
  // The shared Swift package's own lane. It is here for the same reason every
  // other filtered workflow is — its triggers, its concurrency and its
  // push/pull_request path symmetry would otherwise be governed by nothing.
  // WHAT it owns (the repository's sole unfiltered `swift test`, the ordered
  // `!apps/RelayiumKit/Tests/**` exclusions, and which workflow starts on which
  // package path) belongs to `scripts/test/swift-ci-boundary-test.mjs`.
  { file: "swift-package.yml", dispatch: true, call: true, directPr: false },
  // The Go side of the two Swift<->Go interop classes: a narrow macOS lane that
  // runs ONLY those two classes on a `server/**` change, which
  // `swift-package.yml` never watches. What it may contain (exactly two
  // selectors, forced, one pinned setup-go, the named-execution proof, no
  // `apps/**` path) belongs to `scripts/test/swift-ci-boundary-test.mjs`.
  // `dispatch: false`, like `contracts.yml`: it starts on every change to the
  // tree it watches, and a manual run proves nothing a push does not — a
  // pre-merge hosted run of the same two classes comes from dispatching
  // `swift-package.yml`, which runs them forced as part of its suite.
  { file: "inbox-swift-interop.yml", dispatch: false, call: true, directPr: false },
  // The Android platform's two lanes. `android.yml` is the heavy owner of
  // `apps/android/**` — protocol tests, app unit tests, lint, debug assemble —
  // and `android-interop.yml` is the emulator↔browser acceptance, a separate
  // file for the same reason `native-web-pairing.yml` is separate from
  // `macos.yml`: the two have different input sets and a path filter is
  // per-workflow. Both are here so the trigger, concurrency and budget rules
  // bind them like every other lane.
  { file: "android.yml", dispatch: true, call: true, directPr: false },
  { file: "android-interop.yml", dispatch: true, call: true, directPr: false },
  // The Windows desktop client's heavy owner. Here for the same reason every
  // other filtered workflow is: its triggers, concurrency and push/pull_request
  // symmetry would otherwise be governed by nothing.
  { file: "windows.yml", dispatch: true, call: true, directPr: false },
  { file: "web.yml", dispatch: true, call: true, directPr: false },
  // The root contract tree's own lane. It is here for the reason this list
  // exists at all: a workflow absent from it is bound by none of the trigger,
  // concurrency or path rules below, and nothing says so.
  // `scripts/test/contract-ci-policy-test.mjs` may strengthen what this lane
  // must CONTAIN, but it reads none of the repository-wide rules here and
  // therefore cannot stand in for them. `dispatch: false`, matching the
  // workflow: it starts on every change to the tree it owns, and a manual run
  // would produce nothing a push does not.
  { file: "contracts.yml", dispatch: false, call: true, directPr: false },
  // The product↔ops deploy contract's own lane. Same reason, same shape, and
  // deliberately a SEPARATE entry rather than a fourth job in `contracts.yml`:
  // that document has no Swift and no TypeScript consumer, so sharing the lane
  // would put a PAID macOS runner and an `npm ci` on every edit to it. Which
  // document each lane owns, and that no contract file is left unowned, is
  // `scripts/test/contract-ci-policy-test.mjs`; this entry is what binds the new
  // lane to the trigger, concurrency and runner-budget rules below. `dispatch:
  // false`, matching the workflow: it starts on every change to the one document
  // it owns, and a manual run would produce nothing a push does not.
  { file: "ops-deploy-contract.yml", dispatch: false, call: true, directPr: false },
  // The always-on, deliberately UNFILTERED compatibility gate. It is in this
  // list — and not merely in section 6 — so it is bound by the same trigger and
  // concurrency policy as every heavy workflow it runs in front of.
  //
  // `directPr: false` is the LAST step of the compat migration, and it is
  // permanent. This file used to be the one row where `call` and `directPr`
  // were not opposites, because it declared `wire-vectors` and that bare string
  // was a required context; called, the same job reports as
  // `compat / wire-vectors`, so dropping the direct trigger any earlier would
  // have left the requirement reported by nothing. Protection edit B narrowed
  // `main` to the sole context `merge-gate`, which closed that window, and the
  // duplicate run went with it.
  //
  // `push: main` and `workflow_dispatch` stay. The first is not tidiness: it is
  // the only event that puts a bare `wire-vectors` check run on a `main`
  // commit, and `relayium-ops`' `deploy/promote.sh` refuses to promote without
  // one. docs/CI-PLATFORM-BOUNDARY.md carries the staged order; section 6o
  // binds the entry points and the input surface this file may not grow back.
  { file: "compat.yml", dispatch: true, call: true, directPr: false },
  { file: "native-web-pairing.yml", dispatch: true, call: true, directPr: false },
  { file: "repo-hygiene.yml", dispatch: false, call: true, directPr: false },
];

const NIGHTLY = "account-race-nightly.yml";

/**
 * The fuzz campaign, and the script that tells it what to fuzz.
 *
 * Named here for the same reason every other file in this section is: dropping
 * either from this list would take the whole of section 7 with it, silently.
 */
const FUZZ_NIGHTLY = "go-fuzz-nightly.yml";
const FUZZ_INVENTORY = "scripts/list-go-fuzz-targets.sh";

/**
 * The macOS pair: the read-only CI callee, and the manual release caller.
 *
 * They were one file. `macos.yml` carried a `workflow_dispatch` with five
 * inputs, and its notarization and publication jobs sat beside the ordinary
 * push/pull_request lanes — so the workflow that runs on every commit was also
 * the workflow holding `contents: write`, a `gh release create`, a `git push
 * origin …:main`, an Apple notary key and the Sparkle private key. The only
 * thing between an ordinary CI event and an immutable public release was a
 * job-level `if:`, and an `if:` is one edit away from not being there.
 *
 * Now `macos-release.yml` is the sole manual entry point and CALLS `macos.yml`
 * as a reusable workflow, so a release builds through the same signed-build lane
 * every pull request already runs. Section 6m is what keeps that boundary from
 * being reassembled by a copy.
 */
const MACOS = "macos.yml";
const MACOS_RELEASE = "macos-release.yml";

/**
 * The aggregate merge gate, and the pieces its correctness is spread across.
 *
 * It is deliberately NOT in `GOVERNED`: it has no `push` trigger and no path
 * filter, so section 1 would assert things about it that must not be true, and
 * section 5g's matrix excludes unfiltered workflows by construction. Section 6n
 * binds it instead, and section 2 binds its concurrency.
 *
 * `GATE_JOB` is the required status context. Top-level job check names are bare
 * in this repository's own API output — the required context is `wire-vectors`,
 * not `compat / wire-vectors`, whatever the merge box renders — so this job
 * reports as `merge-gate`, and section 6n asserts nothing else on disk may
 * declare that name.
 */
const AGGREGATE = "merge-gate.yml";
const GATE_JOB = "merge-gate";
const SELECT_JOB = "select";
const SELECTOR = "scripts/ci/select-lanes.mjs";
const SELECTOR_TEST = "scripts/test/ci-lane-selector-test.mjs";

/**
 * The gate's conditional lanes, as `caller job id -> called workflow`.
 *
 * The id is not always the workflow's name. `contracts.yml` and
 * `ops-deploy-contract.yml` both declare a job literally called `go-contract`,
 * and the caller job id is the prefix that tells the two check runs apart —
 * hence `ops-contract`.
 */
const GATE_LANES = new Map([
  ["web", "web.yml"],
  ["go", "go.yml"],
  ["macos", MACOS],
  ["ios", "ios.yml"],
  ["ios-transfer-interop", "ios-transfer-interop.yml"],
  ["android", "android.yml"],
  ["android-interop", "android-interop.yml"],
  ["windows", "windows.yml"],
  ["swift-package", "swift-package.yml"],
  ["inbox-swift-interop", "inbox-swift-interop.yml"],
  ["native-web-pairing", "native-web-pairing.yml"],
  ["contracts", "contracts.yml"],
  ["ops-contract", "ops-deploy-contract.yml"],
]);

/**
 * Called with no condition, because every change must pass what they host.
 *
 * ORDER IS LOAD-BEARING: the aggregate's `UNCONDITIONAL_LANES` literal is
 * compared against this array WITHOUT sorting, so the shell roster and this one
 * are the same sequence or the check fails by name.
 *
 * `compat` joined `repo-hygiene` here rather than the conditional lanes for the
 * reason `compat.yml` has no `paths:` filter at all: a wire-compatibility
 * contract a new platform can route around by existing is not a contract. There
 * is nothing to select, so `selected ⇒ success` does not apply and the stronger
 * rule does — it must SUCCEED on every pull request.
 */
const GATE_ALWAYS = ["compat", "repo-hygiene"];

/**
 * `compat.yml`'s concurrency prefix: one literal, nothing else uses it.
 *
 * Declared up here because `LITERAL_GROUP_PREFIX` below needs it, and section
 * 2's exact-group equality is the first thing that would notice it being edited
 * away. Section 6o asserts the properties behind it.
 *
 * This used to be a literal stem plus a `${{ inputs.concurrency_scope ||
 * 'direct' }}` discriminator, and that was load-bearing for exactly one
 * migration step: `compat.yml` was then reachable through TWO entry points on
 * ONE pull request — directly, and through `merge-gate.yml` — and both runs saw
 * the same `github.event.pull_request.number`, so the repository-wide suffix
 * alone put them in the SAME group. With `cancel-in-progress` true the second
 * to start cancelled the first, silently, because a cancelled run reports
 * `cancelled` rather than red.
 *
 * The direct `pull_request:` trigger is gone, so the collision it prevented
 * cannot occur: the only run keyed by a pull request number is the CALLED one,
 * and `push` and `workflow_dispatch` key on `github.run_id`, which is unique
 * per run. A discriminator with one entry point left to discriminate is an
 * input on the always-on compatibility gate and nothing else, so it went with
 * the trigger. Section 6o is what stops either coming back.
 */
const COMPAT_GROUP_PREFIX = "compat-lane";

/**
 * The concurrency key, in two halves.
 *
 * The SUFFIX is repository-wide and is the whole of the rule stated at the top
 * of this file: group by PR number when there is one, by `github.run_id`
 * otherwise. Nothing may deviate from it.
 *
 * The PREFIX is `${{ github.workflow }}` only for a workflow that is neither a
 * reusable callee nor the caller of one. Since `compat.yml` became the gate's
 * second unconditional lane that is two files: the two scheduled nightlies,
 * which nothing calls at all.
 *
 * Every other file here carries a LITERAL prefix, and that is not a style
 * choice. Inside a called workflow `github.workflow` is the CALLER's name, so
 * the shared expression puts every lane `merge-gate.yml` calls into ONE group
 * under one `github.run_id`. With `cancel-in-progress` true on a pull request
 * the lanes then cancel each other, and the aggregate judges cancelled runs;
 * between a caller and its callee it is a deadlock, because the callee queues
 * behind the caller that is waiting for it. Literals nothing else uses make the
 * groups disjoint by construction, whatever any file is renamed to later.
 *
 * `compat.yml` carries an ordinary literal like every other called lane. It
 * briefly needed a discriminator on top of one, because it was the only file
 * reachable through two entry points on a single pull request;
 * `COMPAT_GROUP_PREFIX` above carries what that was for and why it is gone.
 */
const GROUP_SUFFIX = "${{ github.event.pull_request.number || github.run_id }}";
const DEFAULT_GROUP_PREFIX = "${{ github.workflow }}";
const LITERAL_GROUP_PREFIX = new Map([
  [MACOS, "macos-ci"],
  [MACOS_RELEASE, "macos-release"],
  [AGGREGATE, "merge-gate"],
  // Spelled out rather than written as `COMPAT`: that constant is declared far
  // below, and a `const` referenced above its declaration is a TDZ
  // ReferenceError at module load — this whole file would fail to run.
  ["compat.yml", COMPAT_GROUP_PREFIX],
  ["web.yml", "web-lane"],
  ["go.yml", "go-lane"],
  ["ios.yml", "ios-lane"],
  ["ios-transfer-interop.yml", "ios-transfer-interop-lane"],
  ["android.yml", "android-lane"],
  ["android-interop.yml", "android-interop-lane"],
  ["windows.yml", "windows-lane"],
  ["swift-package.yml", "swift-package-lane"],
  ["inbox-swift-interop.yml", "inbox-swift-interop-lane"],
  ["native-web-pairing.yml", "native-web-pairing-lane"],
  ["contracts.yml", "contracts-lane"],
  ["ops-deploy-contract.yml", "ops-deploy-contract-lane"],
  ["repo-hygiene.yml", "repo-hygiene-lane"],
]);
const groupPrefix = (file) => LITERAL_GROUP_PREFIX.get(file) ?? DEFAULT_GROUP_PREFIX;
const expectedGroup = (file) => `${groupPrefix(file)}-${GROUP_SUFFIX}`;
/** The default shape, for the parser fixture and for synthetic platforms below. */
const GROUP = `${DEFAULT_GROUP_PREFIX}-${GROUP_SUFFIX}`;
const CANCEL = "${{ github.event_name == 'pull_request' }}";

const ACCOUNT_PKG = "github.com/relayium/relayium/account";
const SHARD_HELPER = "scripts/go-race-shard.go";
const SHARDS = 8;
/** The A11 relay-renewal driver tests' job, and the one pattern (section 3b). */
const RENEW_JOB = "link-renew";
const RENEW_PATTERN = "^(TestLinkRenew|TestLDRenew)";
/** The renewal lane's measured weights, and the tool that records shard evidence. */
const RENEW_WEIGHTS = "scripts/go-race-timings-renewal.json";
const TIMINGS_TOOL = "scripts/go-race-timings.go";
/**
 * The account lane's measured profile, pinned to the exact corpus root and an
 * independent Codex review accepted: run 36893745143 attempt 1 at 7c47921b9,
 * all eight account shard archives verified against their API digests, 2633
 * tests. Replacing it needs a new accepted corpus and a deliberate edit here.
 */
const ACCOUNT_WEIGHTS = "scripts/go-race-timings-account.json";
const ACCOUNT_WEIGHTS_SHA256 = "e9d0d8b464b095188f602d7340f144be86c8f651f8e01ab93cb2d2c54d0f8abf";
const ACCOUNT_WEIGHTS_PROVENANCE = {
  kind: "go-test-json-corpus", sourceSHA: "7c47921b94b9120d528badc138d34fa0c8a6f1e9",
  toolchain: "go version go1.26.6 linux/amd64", runID: 36893745143, runAttempt: 1, race: true, count: 1, complete: true,
};

const failures = [];
function check(ok, message) {
  if (ok) return;
  failures.push(message);
}

// ── a parser for the YAML subset these workflows use ────────────────────────

class YamlError extends Error {}

/**
 * Parses block mappings, block sequences, inline `[a, b]` sequences, block
 * scalars (`|`, `>`, with optional chomping indicator), anchors and aliases.
 * Everything is returned as a string, array or plain object; no scalar is
 * coerced to a number or boolean, so `on:` stays the string "on" instead of
 * becoming YAML 1.1's `true`.
 */
function parseYaml(text) {
  const lines = text.split("\n");
  const anchors = new Map();
  let i = 0;

  const indentOf = (line) => line.length - line.trimStart().length;
  const isBlank = (line) => line.trim() === "";
  const isComment = (line) => /^\s*#/.test(line);
  const skip = () => {
    while (i < lines.length && (isBlank(lines[i]) || isComment(lines[i]))) i += 1;
  };

  /** Everything indented deeper than `parentIndent`, verbatim. */
  function blockScalar(parentIndent) {
    const out = [];
    while (i < lines.length) {
      if (isBlank(lines[i])) { out.push(""); i += 1; continue; }
      if (indentOf(lines[i]) <= parentIndent) break;
      out.push(lines[i]); i += 1;
    }
    while (out.length && out[out.length - 1] === "") out.pop();
    if (out.length === 0) return "";
    const strip = indentOf(out.find((l) => l !== "") ?? "");
    // Clip chomping: a block scalar keeps exactly one trailing newline. Matching
    // YAML here rather than approximating it is what lets this parser be diffed
    // against a real implementation.
    return out.map((l) => l.slice(strip)).join("\n") + "\n";
  }

  /** Drops a trailing ` # comment`, but not a `#` inside quotes. */
  function stripComment(raw) {
    let quote = null;
    for (let k = 0; k < raw.length; k += 1) {
      const ch = raw[k];
      if (quote) { if (ch === quote) quote = null; continue; }
      if (ch === "'" || ch === '"') { quote = ch; continue; }
      if (ch === "#" && (k === 0 || /\s/.test(raw[k - 1]))) return raw.slice(0, k);
    }
    return raw;
  }

  function unquote(raw) {
    const v = raw.trim();
    if (v.length >= 2 && ((v[0] === "'" && v.endsWith("'")) || (v[0] === '"' && v.endsWith('"')))) {
      return v.slice(1, -1);
    }
    return v;
  }

  function scalar(raw) {
    const v = stripComment(raw).trim();
    if (v.startsWith("[") && v.endsWith("]")) {
      const inner = v.slice(1, -1).trim();
      return inner === "" ? [] : inner.split(",").map((part) => unquote(part));
    }
    return unquote(v);
  }

  /**
   * A value written after `key:` on the same line, or the block beneath it.
   * `keyIndent` is the column the key started at.
   */
  function value(rest, keyIndent) {
    let raw = rest.trim();
    let anchor = null;
    const anchored = raw.match(/^&([A-Za-z0-9_-]+)\s*(.*)$/);
    if (anchored) { anchor = anchored[1]; raw = anchored[2].trim(); }
    const alias = raw.match(/^\*([A-Za-z0-9_-]+)\s*$/);
    if (alias) {
      if (!anchors.has(alias[1])) throw new YamlError(`unknown alias *${alias[1]}`);
      return anchors.get(alias[1]);
    }

    let out;
    if (/^[|>][-+]?\d*$/.test(raw)) {
      out = blockScalar(keyIndent);
    } else if (raw === "" || raw.startsWith("#")) {
      // Either a nested block or an empty value; the indentation decides.
      const save = i;
      skip();
      if (i < lines.length && indentOf(lines[i]) > keyIndent) {
        out = node(keyIndent + 1);
      } else {
        i = save;
        out = null;
      }
    } else {
      out = scalar(raw);
    }
    if (anchor) anchors.set(anchor, out);
    return out;
  }

  function node(minIndent) {
    skip();
    if (i >= lines.length) return null;
    const ind = indentOf(lines[i]);
    if (ind < minIndent) return null;
    return /^\s*-(\s|$)/.test(lines[i]) ? sequence(ind) : mapping(ind);
  }

  function sequence(ind) {
    const out = [];
    for (;;) {
      skip();
      if (i >= lines.length) break;
      if (indentOf(lines[i]) !== ind || !/^\s*-(\s|$)/.test(lines[i])) break;
      const rest = lines[i].slice(ind + 1).replace(/^\s/, "");
      if (rest.trim() === "" || rest.trim().startsWith("#")) {
        i += 1;
        out.push(node(ind + 1));
      } else if (/^[^\s:#][^:#]*:(\s|$)/.test(rest)) {
        // `- key: v` opens a mapping whose other keys line up two columns in.
        // Rewriting the dash to spaces lets the mapping parser see all of them.
        lines[i] = " ".repeat(ind + 2) + rest;
        out.push(mapping(ind + 2));
      } else {
        i += 1;
        out.push(scalar(rest));
      }
    }
    return out;
  }

  function mapping(ind) {
    const out = {};
    for (;;) {
      skip();
      if (i >= lines.length) break;
      if (indentOf(lines[i]) !== ind) break;
      const m = lines[i].match(/^\s*([^:#\s][^:#]*?)\s*:(.*)$/);
      if (!m) {
        throw new YamlError(`cannot parse line ${i + 1}: ${JSON.stringify(lines[i])}`);
      }
      const key = unquote(m[1]);
      const rest = m[2];
      i += 1;
      out[key] = value(rest, ind);
    }
    return out;
  }

  const doc = node(0);
  skip();
  if (i < lines.length) {
    throw new YamlError(`trailing content at line ${i + 1}: ${JSON.stringify(lines[i])}`);
  }
  return doc;
}

// ── prove the parser before trusting anything it produces ───────────────────

/** Deep structural equality, enough for the plain objects/arrays/strings above. */
function deepEqual(a, b) {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b)
      && a.length === b.length && a.every((v, i) => deepEqual(v, b[i]));
  }
  if (a && b && typeof a === "object" && typeof b === "object") {
    const ka = Object.keys(a);
    const kb = Object.keys(b);
    return ka.length === kb.length && ka.every((k) => deepEqual(a[k], b[k]));
  }
  return false;
}

/**
 * Every construct the governed workflows actually use, parsed and compared
 * against the exact object it must produce.
 *
 * Each line here corresponds to something real: `paths: &paths` / `*paths` is
 * how web.yml and native-web-pairing.yml share one path list, `run: |` is every
 * shell step, the `${{ ... }}` concurrency values are quoted expressions
 * containing braces, and `on:` is the key YAML 1.1 would otherwise turn into
 * the boolean `true` and hide from every check below.
 *
 * The `workflow_call:` block and the `uses:`/`with:`/`secrets:` job arrived with
 * the macOS CI/release split, and section 6m reads every one of them. The output
 * value is the fixture's most load-bearing line: `jobs['signed-build']` carries a
 * single-quoted string INSIDE an unquoted scalar, and a parser that treated that
 * quote as the start of a quoted value — or that dropped everything after a `#`
 * it never sees here but would in a sibling line — would hand 6m a mangled
 * expression and its bracket-syntax check would pass or fail for the wrong
 * reason.
 */
function assertParserReadsTheWorkflowSubset() {
  const fixture = [
    "name: sample",
    "on:",
    "  push:",
    "    branches:",
    "      - main",
    "    paths: &paths",
    "      - 'web/**'",
    "      - '.github/workflows/web.yml'",
    "  pull_request:",
    "    paths: *paths",
    "  workflow_dispatch:",
    "  workflow_call:",
    "    inputs:",
    "      release_version:",
    "        required: false",
    "        default: ''",
    "        type: string",
    "    secrets:",
    "      MACOS_SIGNING_CERT_PASSWORD:",
    "        required: false",
    "    outputs:",
    "      signed_artifact:",
    "        value: ${{ jobs['signed-build'].outputs.signed_artifact }}",
    "",
    "# a full-line comment",
    "concurrency:",
    "  group: ${{ github.workflow }}-${{ github.event.pull_request.number || github.run_id }}",
    "  cancel-in-progress: ${{ github.event_name == 'pull_request' }}",
    "",
    "jobs:",
    "  caller:",
    "    uses: ./.github/workflows/macos.yml",
    "    with:",
    "      release_version: ${{ inputs.release_version }}",
    "    secrets:",
    "      MACOS_SIGNING_CERT_PASSWORD: ${{ secrets.MACOS_SIGNING_CERT_PASSWORD }}",
    "  build:",
    "    runs-on: ubuntu-latest",
    "    timeout-minutes: 25",
    "    strategy:",
    "      fail-fast: false",
    "      matrix:",
    "        shard: [0, 1, 2]",
    "    steps:",
    "      - uses: actions/checkout@abc123 # v6.0.2",
    "      - name: shell step",
    "        run: |",
    "          go test -race -count=1 \\",
    "            -run \"$RUN_REGEX\" ./account",
    "      - name: folded",
    "        run: >-",
    "          one",
    "  quoted:",
    "    runs-on: ubuntu-latest",
    "    steps:",
    "      - run: echo \"not # a comment\"",
    "",
  ].join("\n");

  const want = {
    name: "sample",
    on: {
      push: { branches: ["main"], paths: ["web/**", ".github/workflows/web.yml"] },
      pull_request: { paths: ["web/**", ".github/workflows/web.yml"] },
      workflow_dispatch: null,
      workflow_call: {
        inputs: { release_version: { required: "false", default: "", type: "string" } },
        secrets: { MACOS_SIGNING_CERT_PASSWORD: { required: "false" } },
        outputs: {
          signed_artifact: { value: "${{ jobs['signed-build'].outputs.signed_artifact }}" },
        },
      },
    },
    concurrency: { group: GROUP, "cancel-in-progress": CANCEL },
    jobs: {
      caller: {
        uses: "./.github/workflows/macos.yml",
        with: { release_version: "${{ inputs.release_version }}" },
        secrets: { MACOS_SIGNING_CERT_PASSWORD: "${{ secrets.MACOS_SIGNING_CERT_PASSWORD }}" },
      },
      build: {
        "runs-on": "ubuntu-latest",
        "timeout-minutes": "25",
        strategy: { "fail-fast": "false", matrix: { shard: ["0", "1", "2"] } },
        steps: [
          { uses: "actions/checkout@abc123" },
          { name: "shell step", run: "go test -race -count=1 \\\n  -run \"$RUN_REGEX\" ./account\n" },
          { name: "folded", run: "one\n" },
        ],
      },
      quoted: {
        "runs-on": "ubuntu-latest",
        steps: [{ run: 'echo "not # a comment"' }],
      },
    },
  };

  let got;
  try {
    got = parseYaml(fixture);
  } catch (err) {
    check(false, `the YAML parser threw on its own fixture: ${err.message}. Every policy check `
      + `below reads values through it, so they would all be testing the parser rather than the `
      + `workflows.`);
    return;
  }
  check(
    deepEqual(got, want),
    `the YAML parser no longer reads the workflow subset correctly.\n  got:  ${JSON.stringify(got)}\n`
    + `  want: ${JSON.stringify(want)}\n`
    + `Every assertion in this file reads through this parser, so a parser that returns the wrong `
    + `value — or undefined — makes the policy checks pass or fail for the wrong reason.`,
  );
  // Stated separately, because it is the one that fails SILENTLY: YAML 1.1
  // resolves the bare key `on` to the boolean true, and a parser that did so
  // would leave doc.on undefined and every trigger check below would be
  // asserting against nothing.
  check(
    got && typeof got === "object" && "on" in got && !("true" in got),
    `the parser resolved the \`on:\` key to something other than the string "on". Every trigger `
    + `check in this file reads \`doc.on\`, so they would all be inspecting undefined.`,
  );
}

assertParserReadsTheWorkflowSubset();

// ── load every governed workflow ────────────────────────────────────────────

const files = [...GOVERNED.map((g) => g.file), NIGHTLY, FUZZ_NIGHTLY];
const docs = new Map();
for (const file of files) {
  let text;
  try {
    text = await readFile(resolve(workflowsDir, file), "utf8");
  } catch {
    check(false, `${file} is missing. It is named in this test's policy list, so removing or `
      + `renaming it without updating that list would silently drop it from the trigger and `
      + `concurrency policy.`);
    continue;
  }
  try {
    docs.set(file, parseYaml(text));
  } catch (err) {
    check(false, `${file} could not be parsed: ${err.message}`);
  }
}

/**
 * Workflows this file parses for their RUNNER BUDGET and escape hatches only.
 *
 * `release.yml` is deliberately NOT in `GOVERNED`. It is tag-triggered, has no
 * `concurrency:` block and answers to none of the trigger rules in sections 1-3,
 * so listing it there would assert things about it that are not true. But it is
 * one of the two most expensive lanes here — the other is `ios.yml`, which IS
 * governed — and section 6i has to be able to read its jobs.
 *
 * Parsed here rather than in the loop above so `assertParseWasNotVacuous()`
 * keeps applying its `on`/`concurrency`/`jobs` rule to governed workflows only.
 * A parse failure is still a reported failure, not a silent skip.
 */
/*
 * `macos-release.yml` joins it for a different reason, and belongs in neither
 * `GOVERNED` nor the trigger rules: it has no `push` and no `pull_request` by
 * design — it is the manual release entry point — so section 1 would assert
 * things about it that must not be true. What it does have is the two most
 * dangerous jobs in this repository, one of them on a PAID macOS runner, and
 * section 6i has to bound both. Its dispatch-only shape, its concurrency and its
 * whole boundary against the CI half are asserted in section 6m instead.
 */
const BUDGET_ONLY = ["release.yml", MACOS_RELEASE];

/**
 * Parsed for section 6n, and for nothing else.
 *
 * `merge-gate.yml` belongs in neither `GOVERNED` nor `BUDGET_ONLY`. It has no
 * `push` and no path filter, so section 1 would assert things about it that
 * must not be true and section 5g's matrix excludes it by construction; it
 * holds no paid runner, so section 6i has nothing to budget. What it holds is
 * the one status `main` can require, and section 6n is what keeps that status
 * meaning what it says.
 */
const EXTRA_PARSED = [AGGREGATE];
for (const file of [...BUDGET_ONLY, ...EXTRA_PARSED]) {
  let text;
  try {
    text = await readFile(resolve(workflowsDir, file), "utf8");
  } catch {
    check(false, `${file} is missing. It is named in this test's runner-budget or aggregate-gate `
      + `list, so removing or renaming it without updating that list would silently drop it from `
      + `the timeout and escape-hatch policy in section 6i, or from the merge-gate policy in `
      + `section 6n.`);
    continue;
  }
  try {
    docs.set(file, parseYaml(text));
  } catch (err) {
    check(false, `${file} could not be parsed: ${err.message}`);
  }
}

/**
 * A parse that produced an empty or near-empty document must not read as a
 * policy pass. Each governed workflow has, at minimum, a trigger map, a
 * concurrency block and at least one job; if any of those came out missing, the
 * checks further down would be inspecting `undefined` and reporting on it as
 * though the workflow said so.
 */
function assertParseWasNotVacuous() {
  // `macos-release.yml` is included even though it is BUDGET_ONLY: sections 6i
  // and 6m read its triggers, its concurrency and its jobs, so an empty parse
  // of it would make both of them pass by inspecting nothing. `release.yml` is
  // not — it genuinely declares no `concurrency:` block, and demanding one here
  // would be asserting a property it never had.
  for (const file of [...files, MACOS_RELEASE, ...EXTRA_PARSED]) {
    const doc = docs.get(file);
    if (!doc) continue; // already reported as missing or unparseable
    check(
      doc.on && typeof doc.on === "object" && Object.keys(doc.on).length > 0,
      `${file}: parsed with no \`on:\` triggers at all. That is a parser failure, not a workflow `
      + `without triggers — GitHub would not run it.`,
    );
    check(
      doc.concurrency && typeof doc.concurrency === "object",
      `${file}: parsed with no \`concurrency:\` block.`,
    );
    check(
      doc.jobs && typeof doc.jobs === "object" && Object.keys(doc.jobs).length > 0,
      `${file}: parsed with no jobs.`,
    );
  }
}

assertParseWasNotVacuous();

// ── 6x. PR→main evidence reuse: the canonical adoption, then the full path ──
//
// A `main` push may WITNESS a lane instead of re-running it when the merged
// pull request's latest merge-gate run already proved the same tree
// (scripts/ci/ci-evidence.mjs decides; scripts/ci/ci-evidence-registry.json
// says which lanes, jobs and check names). That adds to a lane workflow, and
// nothing else: an `evidence` job (never red), for a lane with paid macOS/Windows
// probes a read-only `screen` job and the `certify-*` jobs it alone can enable,
// three witness steps at the head of each reusable job, a toolchain capture at
// the end of each certified job, a `reuse != 'true'` guard on every original
// step, an explicit `!cancelled()` job condition carrying each original job's
// own needs/if — plus, for a platform job, a runner that is Ubuntu only on the
// witness path. "6x graph" then evaluates what actually runs, by outcome.
//
// Every rule in sections 1-8 was written about the ORIGINAL steps, and every
// one of them must keep holding for the path that still runs them. So this
// section does two things, in this order:
//
//   1. It asserts the adoption is EXACTLY canonical, against the raw workflows
//      — the evidence job's whole shape, the witness steps, the guard forms,
//      the runner ternary, the registry's job and check-name inventory, the
//      merge gate's grants and producer, the selector's control files and the
//      lanes' path filters — and mutates each of those to prove it can fail.
//   2. It projects each lane to its FULL PATH — the job as it runs when the
//      decision is false, empty or unknown — by removing only those canonical
//      constructs, and hands that projection to every other section. A guard
//      written in any other shape is NOT stripped, so the older rules (a gate
//      step that can skip itself, an iOS job off the Apple runner, an Xcode
//      selection under a condition) still see it and still fail.
//
// What the witness path may do is therefore stated once, here, and what the
// full path must do is still stated by the sections that own it.

const EVIDENCE_REGISTRY_FILE = "scripts/ci/ci-evidence-registry.json";
const EVIDENCE_INPUTS = ["scripts/ci/ci-evidence.mjs", EVIDENCE_REGISTRY_FILE, "scripts/ci/select-lanes.mjs",
  "scripts/ci/ci-evidence-view.mjs", "scripts/test/ci-evidence-test.mjs", "scripts/ci/ci-evidence-toolchain.mjs",
  "scripts/ci/ci-evidence-toolchain-registry.json", "scripts/test/ci-evidence-toolchain-test.mjs"];
const EV_FULL = "needs.evidence.outputs.reuse != 'true'";
const EV_WITNESS = "needs.evidence.outputs.reuse == 'true'";
const EV_MAIN_PUSH = "github.event_name == 'push' && github.ref == 'refs/heads/main'";
const EV_CHECKOUT = "actions/checkout@de0fac2e4500dabe0009e67214ff5f5447ce83dd";
const EV_NODE = "actions/setup-node@48b55a011bda9f5d6aeb4c2d9c7362e8dae4041e";
const EV_UPLOAD = "actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a";
const EV_GRANTS = { contents: "read", actions: "read", "pull-requests": "read" };
/** The paid probes run only on an ordinary main push the screen found eligible. */
const EV_SCREEN_ELIGIBLE = "needs.screen.result == 'success' && needs.screen.outputs.eligible == 'true'";
const EV_CERTIFY_IF = `\${{ !cancelled() && ${EV_MAIN_PUSH} && ${EV_SCREEN_ELIGIBLE} }}`;
const EV_SCREEN_IF = `\${{ !cancelled() && ${EV_MAIN_PUSH} }}`;
/**
 * An original job's condition once it also needs the evidence job: implicit
 * `success()` spelled out over its ORIGINAL needs only, behind `!cancelled()`,
 * so no outcome of the evidence job (failed setup, timeout, skip) can skip it.
 */
const evJobCondition = (needs, original) => `\${{ ${["!cancelled()", ...needs.map((n) => `needs.${n}.result == 'success'`),
  ...(original === undefined ? [] : [`(${original})`])].join(" && ")} }}`;
/**
 * Callers of an adopted lane OUTSIDE the merge gate that do not yet grant the
 * evidence job's read-only permissions. A called workflow may not request more
 * than its caller gives, so such a caller fails to START. Each entry names its
 * owner; it must be removed in the change that adds the grant (the rule below
 * fails on a stale entry), and nothing else may be added here.
 */
const EVIDENCE_CALLER_GRANT_PENDING = {};
/** Lanes the gate calls that deliberately carry no evidence job, and why. */
const EVIDENCE_NOT_ADOPTED = {
  windows: "not in the PR→main evidence scope of 2026-10-01; its jobs always run on main",
  "repo-hygiene": "the cross-cutting policy guards stay fresh on every main push by rule",
};

let evidenceRegistry = null;
try {
  evidenceRegistry = JSON.parse(readFileSync(resolve(repoRoot, EVIDENCE_REGISTRY_FILE), "utf8"));
} catch (err) {
  check(false, `${EVIDENCE_REGISTRY_FILE} is unreadable (${err.message}); 6x cannot judge the evidence adoption.`);
}

/** The witness steps a reusable job must start with, exactly. */
function canonicalWitnessSteps(laneId, needsWorkdir) {
  const confirm = {
    name: "Witness — the pull request's full proof covers this job",
    if: EV_WITNESS,
    ...(needsWorkdir ? { "working-directory": "." } : {}),
    shell: "bash",
    env: { CI_EVIDENCE_WITNESS: "${{ needs.evidence.outputs.witness }}" },
    run: `node scripts/ci/ci-evidence.mjs confirm ${laneId}`,
  };
  return [
    { name: "Check out the verifier (witness path only)", if: EV_WITNESS, uses: EV_CHECKOUT,
      with: { "persist-credentials": "false" } },
    { name: "Node for the verifier (witness path only)", if: EV_WITNESS, uses: EV_NODE,
      with: { "node-version": "24" } },
    confirm,
  ];
}

/** A step's identity for `freshSteps`: its name, else its action, else its command. */
const stepIdentity = (step) => step?.name ?? (step?.uses ? String(step.uses).split("@")[0] : String(step?.run ?? "").trim());

const mentionsEvidence = (value) => JSON.stringify(value ?? null).includes("needs.evidence");

/**
 * The original condition a canonical guard wraps: `undefined` for a bare guard,
 * the original text otherwise, or `null` when the condition is not one of the
 * five canonical forms. The original must not itself mention the evidence job.
 */
function unwrapGuard(condition) {
  if (condition === EV_FULL) return undefined;
  if (condition === `failure() && ${EV_FULL}`) return "failure()";
  if (condition === `always() && ${EV_FULL}`) return "always()";
  let m = String(condition ?? "").match(/^always\(\) && needs\.evidence\.outputs\.reuse != 'true' && \((.+)\)$/s);
  if (m && !mentionsEvidence(m[1])) return `always() && ${m[1]}`;
  m = String(condition ?? "").match(/^needs\.evidence\.outputs\.reuse != 'true' && \((.+)\)$/s);
  if (m && !mentionsEvidence(m[1])) return m[1];
  return null;
}

const EVIDENCE_TOOLCHAIN_FILE = "scripts/ci/ci-evidence-toolchain-registry.json";
let evidenceToolchain = null;
try {
  evidenceToolchain = JSON.parse(readFileSync(resolve(repoRoot, EVIDENCE_TOOLCHAIN_FILE), "utf8"));
} catch (err) {
  check(false, `${EVIDENCE_TOOLCHAIN_FILE} is unreadable (${err.message}); 6x cannot judge the toolchain certificates.`);
}
const EV_CERTIFY_JOBS = { "macos-15": "certify-macos", "windows-latest": "certify-windows" };
const EV_CACHE_INPUTS = ["cache", "cache-dependency-path"];

/** A lane step as a probe must copy it: no id, no cache inputs, `condition` as its if. Built here, not by the generator. */
function probeCopyOf(fullDoc, ref, condition) {
  const hits = (fullDoc?.jobs?.[ref.job]?.steps ?? []).filter((st) => stepIdentity(st) === ref.step);
  if (hits.length !== 1) throw new Error(`${ref.job} has ${hits.length} steps named ${JSON.stringify(ref.step)}`);
  const st = structuredClone(hits[0]);
  delete st.id;
  if (st.with) {
    for (const k of EV_CACHE_INPUTS) delete st.with[k];
    if (Object.keys(st.with).length === 0) delete st.with;
  }
  if (condition) st.if = condition;
  return st;
}

/** What the toolchain registry requires of one lane, against its full-path document. */
function evidencePlanOf(fullDoc, laneId, lane, tool) {
  const tl = tool?.lanes?.[laneId];
  if (!tl) throw new Error(`lane ${laneId} is not in the toolchain registry`);
  const profiles = {};
  for (const [jobId, job] of Object.entries(lane.jobs)) {
    if (job.mode === "fresh") continue;
    const t = tl.jobs?.[jobId];
    if (!t) throw new Error(`${laneId}/${jobId} has no toolchain entry`);
    if (t.profile) profiles[jobId] = t.profile;
  }
  const of = (runner) => [...new Set(Object.values(profiles).filter((p) => tool.profiles[p]?.runner === runner))].sort();
  return {
    profiles,
    ubuntu: of("ubuntu-latest"),
    ubuntuSteps: (tl.ubuntuSetup ?? []).map((ref) => probeCopyOf(fullDoc, ref, EV_MAIN_PUSH)),
    certify: Object.keys(EV_CERTIFY_JOBS).filter((r) => of(r).length).map((runner) => ({
      runner, job: EV_CERTIFY_JOBS[runner], profiles: of(runner),
      steps: (tl.certify?.[runner] ?? []).map((ref) => probeCopyOf(fullDoc, ref, undefined)),
    })),
  };
}

/** The availability screen in front of a lane's paid certify jobs, exactly. */
function canonicalScreenJob(laneId, lane) {
  const env = { GH_TOKEN: "${{ github.token }}" };
  if (lane.scope) {
    env[`CI_EVIDENCE_SCOPE_${lane.scope.output.toUpperCase()}`] = `\${{ needs.${lane.scope.job}.outputs.${lane.scope.output} }}`;
  }
  return {
    ...(lane.scope ? { needs: lane.scope.job } : {}),
    if: EV_SCREEN_IF,
    "runs-on": "ubuntu-latest",
    "timeout-minutes": "5",
    "continue-on-error": "true",
    permissions: { ...EV_GRANTS },
    outputs: { eligible: "${{ steps.screen.outputs.eligible }}" },
    steps: [
      { name: "Check out the verifier", uses: EV_CHECKOUT, with: { "persist-credentials": "false" } },
      { name: "Node for the verifier", uses: EV_NODE, with: { "node-version": "24" } },
      { name: "Could a current toolchain certificate complete a proof?", id: "screen", env,
        run: `node scripts/ci/ci-evidence.mjs screen ${laneId} >> "$GITHUB_OUTPUT"` },
    ],
  };
}

function canonicalCertifyJob(c) {
  return {
    needs: "screen",
    if: EV_CERTIFY_IF,
    "runs-on": c.runner,
    "timeout-minutes": "3",
    "continue-on-error": "true",
    outputs: { certificates: "${{ steps.export.outputs.certificates }}" },
    steps: [
      { name: "Check out the probe", uses: EV_CHECKOUT, with: { "persist-credentials": "false" } },
      ...c.steps,
      { name: "Certify this runner's toolchain now", shell: "bash",
        run: `node scripts/ci/ci-evidence-toolchain.mjs current --profiles ${c.profiles.join(",")} --dir "$RUNNER_TEMP/ci-evidence-current"` },
      { name: "Hand the certificates to the evidence job", id: "export", shell: "bash",
        run: 'node scripts/ci/ci-evidence-toolchain.mjs export --dir "$RUNNER_TEMP/ci-evidence-current" >> "$GITHUB_OUTPUT"' },
    ],
  };
}

/** The evidence job a lane must declare, exactly. */
function canonicalEvidenceJob(laneId, lane, plan) {
  const env = { GH_TOKEN: "${{ github.token }}" };
  if (lane.scope) {
    env[`CI_EVIDENCE_SCOPE_${lane.scope.output.toUpperCase()}`] = `\${{ needs.${lane.scope.job}.outputs.${lane.scope.output} }}`;
  }
  env.CI_EVIDENCE_CURRENT_TOOLCHAIN_DIR = "${{ runner.temp }}/ci-evidence-current";
  env.CI_EVIDENCE_WITNESS_FILE = `\${{ runner.temp }}/ci-evidence-witness/${laneId}.json`;
  const needs = [...(lane.scope ? [lane.scope.job] : []), ...(plan.certify.length ? ["screen"] : []), ...plan.certify.map((c) => c.job)];
  return {
    ...(needs.length === 1 ? { needs: needs[0] } : needs.length > 1 ? { needs } : {}),
    ...(needs.length ? { if: "${{ !cancelled() }}" } : {}),
    "runs-on": "ubuntu-latest",
    "timeout-minutes": "10",
    "continue-on-error": "true",
    permissions: { ...EV_GRANTS },
    outputs: { reuse: "${{ steps.handover.outputs.reuse }}", witness: "${{ steps.handover.outputs.witness }}" },
    steps: [
      { name: "Check out the verifier (ordinary main push only)", if: EV_MAIN_PUSH, uses: EV_CHECKOUT,
        with: { "persist-credentials": "false" } },
      { name: "Node for the verifier (ordinary main push only)", if: EV_MAIN_PUSH, uses: EV_NODE,
        with: { "node-version": "24" } },
      ...plan.ubuntuSteps,
      ...(plan.ubuntu.length ? [{ name: "Certify this runner's toolchain now (ordinary main push only)", if: EV_MAIN_PUSH, shell: "bash",
        run: `node scripts/ci/ci-evidence-toolchain.mjs current --profiles ${plan.ubuntu.join(",")} --dir "$RUNNER_TEMP/ci-evidence-current"` }] : []),
      ...(plan.certify.length ? [{ name: "Take the certify jobs' certificates (ordinary main push only)", if: EV_MAIN_PUSH, shell: "bash",
        env: Object.fromEntries(plan.certify.map((c) => [`CI_EVIDENCE_CERTIFICATES_${c.job.slice(8).toUpperCase()}`,
          `\${{ needs['${c.job}'].outputs.certificates }}`])),
        run: 'node scripts/ci/ci-evidence-toolchain.mjs import --dir "$RUNNER_TEMP/ci-evidence-current"' }] : []),
      { name: "Does the merged pull request's full proof cover this main tree?", id: "verify", if: EV_MAIN_PUSH,
        env, run: `node scripts/ci/ci-evidence.mjs witness ${laneId} >> "$GITHUB_OUTPUT"` },
      { name: "Keep the witness (reuse only)", id: "keep", if: "steps.verify.outputs.reuse == 'true'", uses: EV_UPLOAD,
        with: {
          name: `relayium-ci-evidence-witness-${laneId}-attempt-\${{ github.run_attempt }}`,
          path: "${{ runner.temp }}/ci-evidence-witness", "if-no-files-found": "error", "retention-days": "30",
        } },
      // The ONLY source of the job's outputs, and only after the witness was kept.
      { name: "Hand the decision to the lane only once its witness is kept", id: "handover",
        if: "steps.verify.outputs.reuse == 'true' && steps.keep.outcome == 'success'",
        env: { CI_EVIDENCE_WITNESS: "${{ steps.verify.outputs.witness }}",
          CI_EVIDENCE_WITNESS_FILE: `\${{ runner.temp }}/ci-evidence-witness/${laneId}.json` },
        run: 'node scripts/ci/ci-evidence.mjs handover >> "$GITHUB_OUTPUT"' },
    ],
  };
}

/** The source capture a certified job must end with, exactly. */
function canonicalCaptureSteps(laneId, jobId, profile, needsWorkdir) {
  return [
    { name: "Certify this job's toolchain", if: EV_FULL, ...(needsWorkdir ? { "working-directory": "." } : {}), shell: "bash",
      env: { CI_EVIDENCE_JOB_INDEX: "${{ strategy.job-index }}", CI_EVIDENCE_JOB_TOTAL: "${{ strategy.job-total }}",
        CI_EVIDENCE_MATRIX: "${{ toJSON(matrix) }}" },
      run: `node scripts/ci/ci-evidence-toolchain.mjs capture --role source --profile ${profile} --lane ${laneId} --job ${jobId} --out "$RUNNER_TEMP/ci-evidence-toolchain/toolchain.json"` },
    { name: "Keep this job's toolchain certificate", if: EV_FULL, uses: EV_UPLOAD,
      with: { name: `relayium-ci-evidence-toolchain-${laneId}-${jobId}-\${{ strategy.job-index }}-attempt-\${{ github.run_attempt }}`,
        path: "${{ runner.temp }}/ci-evidence-toolchain/toolchain.json", "if-no-files-found": "ignore", "retention-days": "7" } },
  ];
}

/** A step stripped of what a probe copy drops (id, cache inputs) and of its evidence guard, for "same rule" comparison. */
function setupRule(step) {
  const st = structuredClone(step);
  delete st.id;
  if (st.if !== undefined) {
    const back = unwrapGuard(st.if);
    if (back === null && st.if !== EV_MAIN_PUSH) return { unguardable: st.if };
    if (back === undefined || st.if === EV_MAIN_PUSH) delete st.if; else st.if = back;
  }
  if (st.with) {
    for (const k of EV_CACHE_INPUTS) delete st.with[k];
    if (Object.keys(st.with).length === 0) delete st.with;
  }
  return st;
}

const EV_RUNNER = /^\$\{\{ needs\.evidence\.outputs\.reuse == 'true' && 'ubuntu-latest' \|\| '([a-z0-9.-]+)' \}\}$/;

/** Every combination a job's matrix produces, as ordered [key, value] lists. */
function matrixCombinations(matrix) {
  if (matrix === undefined) return [[]];
  if (!matrix || typeof matrix !== "object") throw new Error("a matrix that is not a mapping");
  const axes = Object.entries(matrix).filter(([k]) => k !== "include" && k !== "exclude");
  if (matrix.exclude !== undefined) throw new Error("matrix exclude is not modelled");
  let combos = [[]];
  for (const [key, values] of axes) {
    if (!Array.isArray(values) || values.length === 0) throw new Error(`matrix axis ${key} is not a list`);
    combos = combos.flatMap((c) => values.map((v) => [...c, [key, String(v)]]));
  }
  if (matrix.include !== undefined) {
    if (axes.length > 0) throw new Error("matrix include beside axes is not modelled");
    if (!Array.isArray(matrix.include)) throw new Error("matrix include is not a list");
    combos = matrix.include.map((entry) => Object.entries(entry).map(([k, v]) => [k, String(v)]));
  }
  return combos;
}

/** GitHub's check names for one job: its `name:` with matrix values, or `id (values)`, capped at 100. */
function derivedCheckNames(jobId, job) {
  return matrixCombinations(job?.strategy?.matrix).map((combo) => {
    let name;
    if (typeof job.name === "string") {
      name = job.name.replace(/\$\{\{\s*matrix\.([A-Za-z0-9_-]+)\s*\}\}/g, (_, k) => {
        const hit = combo.find(([key]) => key === k);
        if (!hit) throw new Error(`job ${jobId}'s name reads matrix.${k}, which is not in every combination`);
        return hit[1];
      });
      if (name.includes("${{")) throw new Error(`job ${jobId}'s name has an expression this rule does not model`);
    } else {
      name = combo.length === 0 ? jobId : `${jobId} (${combo.map(([, v]) => v).join(", ")})`;
    }
    return name.length > 100 ? `${name.slice(0, 97)}...` : name;
  });
}

function evidenceAdoptionFailures(world) {
  const out = [];
  const need = (ok, message) => { if (!ok) out.push(message); };
  const registry = world.evidenceRegistry;
  if (!registry || typeof registry.lanes !== "object") return [`6x: the evidence registry is not readable as lanes.`];
  const gate = world.docs.get(AGGREGATE);

  // The registry against the gate: every lane is either adopted or excused.
  const gateLanes = [...SELECTOR_LANES.map((l) => l.id), "compat", "repo-hygiene"];
  for (const id of gateLanes) {
    need((registry.lanes[id] !== undefined) !== (EVIDENCE_NOT_ADOPTED[id] !== undefined),
      `6x: lane ${id} is ${registry.lanes[id] ? "in the evidence registry AND excused"
        : "neither in the evidence registry nor excused"}; every lane the merge gate calls must be exactly one `
        + "of the two, so a new lane cannot silently skip the decision or silently gain it.");
  }
  for (const id of Object.keys(registry.lanes)) {
    need(gateLanes.includes(id), `6x: the evidence registry names ${id}, which the merge gate does not call.`);
  }

  for (const [laneId, lane] of Object.entries(registry.lanes)) {
    const file = lane.workflow;
    const doc = world.docs.get(file);
    if (!doc) { out.push(`6x: ${file} (lane ${laneId}) is not parsed by this file; it must be GOVERNED.`); continue; }
    const where = `${file} (evidence lane ${laneId})`;
    const raw = world.texts.get(file);
    if (raw !== undefined) {
      let again = null;
      try { again = adoptText(fullPathText(raw, laneId, lane, world.toolReg), laneId, lane, world.toolReg); } catch (err) { again = `error: ${err.message}`; }
      need(again === raw, `${where}: the file is not exactly the canonical adoption of its own full path `
        + `(scripts/ci/ci-evidence-view.mjs adopt would rewrite it${String(again).startsWith("error:") ? `: ${again}` : ""}). `
        + "Edit the full path and re-run the adoption; a hand-edited witness path is the one this section cannot vouch for.");
    }

    // The main-push trigger stays: it is the event that witnesses, and the one
    // relayium-ops' promotion reads check runs from.
    need(deepEqual(doc.on?.push?.branches, ["main"]), `${where}: \`on.push.branches\` is not exactly [main]; `
      + "the main-push trigger is never removed by evidence reuse.");
    if (!lane.unfiltered) {
      for (const input of EVIDENCE_INPUTS) {
        need((doc.on?.push?.paths ?? []).includes(input), `${where}: \`push.paths\` does not name ${input}. The `
          + "evidence job and every witness step run it, so a change to it must start this lane.");
      }
    }

    // The toolchain plan, against the lane's own full path (the steps a probe copies).
    let plan = null;
    let fullDoc = null;
    try {
      fullDoc = parseYaml(fullPathText(raw ?? "", laneId, lane, world.toolReg));
      plan = evidencePlanOf(fullDoc, laneId, lane, world.toolReg);
    } catch (err) {
      out.push(`${where}: its toolchain plan cannot be derived (${err.message}); every reusable job needs a profile or an `
        + "uncertifiable reason, and every copied probe step must exist exactly once.");
      continue;
    }

    // macOS's serial order, pinned EXPLICITLY. Every generic check above derives
    // the wanted condition from the job's own original `needs`, so a change that
    // consistently re-adds `test` to ui-smoke's needs AND condition is a valid
    // adoption to all of them. ui-smoke waits for `contract` (the Developer ID
    // key's gate) and NOT for `test`; signed-build waits for both.
    if (laneId === "macos") {
      const asList = (n) => (Array.isArray(n) ? n : n === undefined ? [] : [n]);
      for (const [jobId, original, adopted] of [
        ["ui-smoke", ["contract"], ["contract", "evidence"]],
        ["signed-build", ["test", "contract"], ["test", "contract"]],
      ]) {
        need(deepEqual(asList(fullDoc?.jobs?.[jobId]?.needs), original) && deepEqual(asList(doc.jobs?.[jobId]?.needs), adopted),
          `${where}/${jobId}: needs ${JSON.stringify(asList(fullDoc?.jobs?.[jobId]?.needs))} (adopted `
          + `${JSON.stringify(asList(doc.jobs?.[jobId]?.needs))}), want exactly ${JSON.stringify(original)} (adopted `
          + `${JSON.stringify(adopted)}). ui-smoke waits for the contract that gates its Developer ID key, not for the `
          + "unit suite; signed-build needs both.");
      }
    }

    // The evidence job, whole.
    const ev = doc.jobs?.evidence;
    const wantEv = canonicalEvidenceJob(laneId, lane, plan);
    need(deepEqual(ev, wantEv), `${where}: the \`evidence\` job is not the canonical `
      + `one.\n  got:  ${JSON.stringify(ev)}\n  want: ${JSON.stringify(wantEv)}\n`
      + "It must act only on an ordinary push to main, never be skipped by a failed or skipped certify job, hold "
      + "read-only grants and no secret, probe with copies of the lane's own setup steps, and publish only the "
      + "verifier's own decision.");
    // The certify jobs, whole — one per native family the lane's certified jobs use, and no other.
    const certifyIds = plan.certify.map((c) => c.job);
    for (const c of plan.certify) {
      const want = canonicalCertifyJob(c);
      need(deepEqual(doc.jobs?.[c.job], want), `${where}: the \`${c.job}\` job is not the canonical one.\n  got:  `
        + `${JSON.stringify(doc.jobs?.[c.job])}\n  want: ${JSON.stringify(want)}\nIt must run only on an ordinary main `
        + "push, within 3 minutes, never turn the run red, and resolve the toolchain by copies of the lane's own "
        + "selection/setup steps.");
    }
    for (const id of Object.keys(doc.jobs ?? {})) {
      need(!/^certify-/.test(id) || certifyIds.includes(id), `${where}: declares ${id}, a certify job no certified job of `
        + "this lane needs.");
    }
    // The screen: exactly when the lane has paid probes, and exactly canonical.
    if (plan.certify.length) {
      const want = canonicalScreenJob(laneId, lane);
      need(deepEqual(doc.jobs?.screen, want), `${where}: the \`screen\` job is not the canonical one.\n  got:  `
        + `${JSON.stringify(doc.jobs?.screen)}\n  want: ${JSON.stringify(want)}\nIt must be read-only, on an ordinary main `
        + "push only, never red, and only ENABLE the paid certify jobs.");
    } else {
      need(doc.jobs?.screen === undefined, `${where}: declares a \`screen\` job but has no paid certify job to screen.`);
    }

    // The job inventory and the check names, both directions.
    const declared = Object.keys(doc.jobs ?? {}).filter((j) => j !== "evidence" && j !== "screen" && !certifyIds.includes(j));
    const registered = Object.keys(lane.jobs ?? {});
    need(deepEqual([...declared].sort(), [...registered].sort()), `${where}: declares jobs [${declared.join(", ")}], `
      + `the evidence registry lists [${registered.join(", ")}]. A job the registry does not know is a job a witness `
      + "would never be asked to prove; a registered job that is gone is a check name nothing reports.");
    for (const jobId of declared) {
      const job = doc.jobs[jobId];
      const entry = lane.jobs?.[jobId];
      if (!entry) continue;
      let names;
      try { names = derivedCheckNames(jobId, job); } catch (err) {
        out.push(`${where}/${jobId}: ${err.message}; 6x cannot derive its check names.`);
        continue;
      }
      need(deepEqual(names, entry.checks), `${where}/${jobId}: GitHub names this job's checks `
        + `${JSON.stringify(names)}, the registry says ${JSON.stringify(entry.checks)}. The verifier requires each `
        + "registered name to have succeeded in the source run; a drifted name makes reuse impossible or, worse, "
        + "lets a renamed job go unproved.");
      need(job.permissions === undefined, `${where}/${jobId}: declares its own \`permissions:\`; only the evidence `
        + "job may, and only read-only grants.");
      need(!mentionsEvidence(job.if), `${where}/${jobId}: a job-level \`if:\` reads the evidence decision, so `
        + "the decision could skip a whole check instead of witnessing it.");
      // The job condition: every witnessable job, and every fresh job downstream
      // of one, carries exactly its ORIGINAL needs/if as an explicit `!cancelled()`
      // condition — never GitHub's implicit success(), which would let a failed,
      // timed-out or skipped evidence job skip the whole lane.
      const fullJob = fullDoc?.jobs?.[jobId];
      const origNeeds = Array.isArray(fullJob?.needs) ? fullJob.needs : fullJob?.needs === undefined ? [] : [fullJob.needs];
      const downstream = (id, seen = new Set()) => {
        const ns = Array.isArray(fullDoc?.jobs?.[id]?.needs) ? fullDoc.jobs[id].needs : fullDoc?.jobs?.[id]?.needs === undefined ? [] : [fullDoc.jobs[id].needs];
        return ns.some((n) => !seen.has(n) && (seen.add(n), (lane.jobs[n] && lane.jobs[n].mode !== "fresh") || downstream(n, seen)));
      };
      if (entry.mode !== "fresh" || downstream(jobId)) {
        const wantIf = evJobCondition(origNeeds, fullJob?.if);
        need(job.if === wantIf, `${where}/${jobId}: the job condition is ${JSON.stringify(job.if ?? null)}, want exactly `
          + `${JSON.stringify(wantIf)}. With \`needs: evidence\` upstream, any other form lets a failed setup step, a `
          + "timeout or a skipped evidence job SKIP this job instead of running it in full.");
      } else {
        need(deepEqual(job.if, fullJob?.if), `${where}/${jobId}: a fresh job with no witnessable ancestor changed its condition.`);
      }

      if (entry.mode === "fresh") {
        need(!mentionsEvidence(job), `${where}/${jobId}: is registered fresh but reads the evidence decision. `
          + "A fresh job runs its original steps on every main push.");
        continue;
      }

      const needs = Array.isArray(job.needs) ? job.needs : job.needs === undefined ? [] : [job.needs];
      need(needs.includes("evidence"), `${where}/${jobId}: does not \`needs: evidence\`, so its steps read an `
        + "output that does not exist and the witness path is unreachable.");
      const fullRunner = typeof job["runs-on"] === "string" ? (EV_RUNNER.exec(job["runs-on"])?.[1] ?? null) : null;
      if (entry.runner === "ubuntu-latest") {
        need(!mentionsEvidence(job["runs-on"]), `${where}/${jobId}: an Ubuntu job's runner reads the evidence `
          + "decision; only a platform job moves to Ubuntu on the witness path.");
        let prRunner = null;
        try { prRunner = evalRunsOn(job["runs-on"], "pull_request", undefined); } catch { /* reported below */ }
        need(prRunner === "ubuntu-latest", `${where}/${jobId}: runs-on ${JSON.stringify(job["runs-on"])} is not `
          + "ubuntu-latest on a pull request, but the registry says the proof comes from an Ubuntu run.");
      } else {
        need(fullRunner === entry.runner, `${where}/${jobId}: runs-on is ${JSON.stringify(job["runs-on"])}; want `
          + `\${{ ${EV_WITNESS} && 'ubuntu-latest' || '${entry.runner}' }}. Whenever the decision is not exactly `
          + `'true' this job must be on ${entry.runner}, the runner its proof came from.`);
      }

      const steps = job.steps ?? [];
      const wantWitness = canonicalWitnessSteps(laneId, typeof job.defaults?.run?.["working-directory"] === "string");
      need(deepEqual(steps.slice(0, 3), wantWitness), `${where}/${jobId}: does not open with the three canonical `
        + `witness steps.\n  got:  ${JSON.stringify(steps.slice(0, 3))}\n  want: ${JSON.stringify(wantWitness)}\n`
        + "The confirm step binds this check run to the verified proof for exactly this lane and main commit.");
      const profile = plan.profiles[jobId];
      const workdir = typeof job.defaults?.run?.["working-directory"] === "string";
      if (profile) {
        const wantCapture = canonicalCaptureSteps(laneId, jobId, profile, workdir);
        need(deepEqual(steps.slice(-2), wantCapture), `${where}/${jobId}: does not end with the canonical toolchain `
          + `capture for profile ${profile}.\n  got:  ${JSON.stringify(steps.slice(-2))}\n  want: ${JSON.stringify(wantCapture)}\n`
          + "Without it this job's proof has no certificate and can never be witnessed; with another profile it would "
          + "be compared on the wrong toolchain.");
      } else {
        need(!steps.some((st) => st?.name === "Certify this job's toolchain"), `${where}/${jobId}: is uncertifiable `
          + "but captures a toolchain certificate.");
      }
      const original = steps.slice(3, profile ? -2 : undefined);
      const fresh = new Set(entry.freshSteps ?? []);
      need(fresh.size === 0 || (entry.runner === "ubuntu-latest" && job["runs-on"] === "ubuntu-latest"),
        `${where}/${jobId}: keeps steps fresh on ${JSON.stringify(job["runs-on"])}; a witness runs only on `
        + "ubuntu-latest, so a fresh step on a platform job would run a platform command on Ubuntu.");
      const seenFresh = new Map();
      for (const step of original) {
        const id = stepIdentity(step);
        if (fresh.has(id)) {
          seenFresh.set(id, (seenFresh.get(id) ?? 0) + 1);
          need(!mentionsEvidence(step), `${where}/${jobId}: fresh step ${JSON.stringify(id)} reads the evidence `
            + "decision; a fresh step runs on both paths unchanged.");
          continue;
        }
        need(step?.if !== undefined && unwrapGuard(step.if) !== null, `${where}/${jobId}: step ${JSON.stringify(id)} `
          + `carries \`if: ${step?.if ?? "(none)"}\`. Every original step must be guarded by exactly \`${EV_FULL}\`, `
          + "alone or in one of the canonical compositions, so a false, empty or unknown decision runs it as "
          + "before and the witness path runs nothing that belongs to the platform.");
      }
      for (const id of fresh) {
        need(seenFresh.get(id) === 1, `${where}/${jobId}: registry fresh step ${JSON.stringify(id)} matches `
          + `${seenFresh.get(id) ?? 0} steps, want exactly 1.`);
      }
    }
    // "Same rule": a probe copy must be EXACTLY the selection/setup each job of
    // that family runs (modulo the cache inputs and the evidence guard), and a
    // macOS job may select its own Xcode only if the lane's certify job copies
    // that selection — otherwise the current probe would certify another Xcode.
    const familyOf = (jobId) => world.toolReg.profiles[plan.profiles[jobId]]?.runner;
    const copiesFor = (runner) => (runner === "ubuntu-latest" ? (doc.jobs?.evidence?.steps ?? [])
      : (doc.jobs?.[EV_CERTIFY_JOBS[runner]]?.steps ?? [])).filter((st) => st?.name !== "Check out the probe"
      && !/^(Certify this runner's toolchain now|Hand the certificates|Take the certify jobs|Check out the verifier|Node for the verifier|Does the merged|Keep the witness|Hand the decision)/.test(st?.name ?? ""));
    const SETUP = /^actions\/setup-(go|node|java)$/;
    for (const jobId of Object.keys(plan.profiles)) {
      const runner = familyOf(jobId);
      const copies = copiesFor(runner).map(setupRule);
      const components = world.toolReg.profiles[plan.profiles[jobId]].components;
      for (const st of (doc.jobs?.[jobId]?.steps ?? []).slice(3, -2)) {
        const id = stepIdentity(st);
        const action = SETUP.exec(id)?.[1];
        const selects = /DEVELOPER_DIR|RELAYIUM_SELECT_XCODE|xcode-select -s/.test(JSON.stringify(st?.run ?? ""));
        const sdk = /sdkmanager/.test(String(st?.run ?? ""));
        if (!action && !selects && !sdk) continue;
        if (action && !components.includes(action === "go" ? "go" : action)) continue;
        const rule = setupRule(st);
        need(copies.some((c) => deepEqual(c, rule)), `${where}/${jobId}: its ${JSON.stringify(id)} step is not exactly `
          + `copied into the ${runner} probe (${runner === "ubuntu-latest" ? "evidence" : EV_CERTIFY_JOBS[runner]}), so the `
          + "current certificate would describe a toolchain this job does not resolve.");
      }
    }
    if (lane.scope) {
      const gated = lane.scope.gates;
      for (const g of gated) {
        need(String(fullDoc?.jobs?.[g]?.if ?? "") === `needs.${lane.scope.job}.outputs.${lane.scope.output} != 'false'`,
          `${where}/${g}: is registered as gated by ${lane.scope.job}.${lane.scope.output} but does not carry that `
          + "job-level condition, so the witness would require (or excuse) it against a different rule.");
      }
    }
  }

  // The merge gate: grants for exactly the adopted lanes, the producer after
  // the judgement, on pull_request only.
  if (!gate) return [...out, `6x: ${AGGREGATE} is not parsed.`];
  for (const id of gateLanes) {
    const caller = gate.jobs?.[id];
    if (!caller) continue;
    if (registry.lanes[id]) {
      need(deepEqual(caller.permissions, EV_GRANTS), `${AGGREGATE}/${id}: permissions are `
        + `${JSON.stringify(caller.permissions)}, want exactly ${JSON.stringify(EV_GRANTS)} — the evidence job's `
        + "read-only grants and nothing more.");
    } else {
      need(caller.permissions === undefined, `${AGGREGATE}/${id}: carries permissions, but the lane has no evidence job.`);
    }
  }
  const agg = gate.jobs?.[GATE_JOB];
  need(deepEqual(agg?.permissions, { contents: "read", actions: "read" }), `${AGGREGATE}/${GATE_JOB}: permissions `
    + `are ${JSON.stringify(agg?.permissions)}, want exactly {contents: read, actions: read}.`);
  const steps = agg?.steps ?? [];
  // The frozen release-metadata dispatch is the second proof kind and the
  // internal full candidate the third; the gate's other dispatch mode
  // (`pull-request`) and every other event produce nothing.
  const pr = "github.event_name == 'pull_request' || (github.event_name == 'workflow_dispatch' && (inputs.mode == 'frozen-release-metadata' || inputs.mode == 'internal-full-candidate'))";
  const modeOptions = gate.on?.workflow_dispatch?.inputs?.mode?.options;
  // `full-bootstrap` is a fourth mode that validates main and proves NOTHING:
  // the producer condition below names only the frozen and internal modes, so
  // it can never mint a proof for it.
  need(deepEqual(modeOptions, ["pull-request", "frozen-release-metadata", "internal-full-candidate", "full-bootstrap"]), `${AGGREGATE}: the dispatch modes are `
    + `${JSON.stringify(modeOptions)}, want exactly [pull-request, frozen-release-metadata, internal-full-candidate, full-bootstrap]; the producer is `
    + "wired to the accepted frozen and internal modes and a new mode must not inherit it.");
  const want = [
    { name: "Check out the merge commit this run tested", if: pr, uses: EV_CHECKOUT, with: { "persist-credentials": "false" } },
    { name: "Node for the evidence verifier", if: pr, uses: EV_NODE, with: { "node-version": "24" } },
    { name: "Evidence verifier tests", if: pr, env: { CI_EVIDENCE_TEST_SCOPE: "verifier" }, run: "node scripts/test/ci-evidence-test.mjs" },
    { name: "Record this run's full proof for main", if: pr, env: {
      GH_TOKEN: "${{ github.token }}", CI_EVIDENCE_NEEDS: "${{ toJSON(needs) }}",
      CI_EVIDENCE_SELECTED: "${{ toJSON(needs.select.outputs) }}",
      CI_EVIDENCE_OUT: "${{ runner.temp }}/ci-evidence/ci-evidence.json",
      CI_EVIDENCE_DISPATCH_MODE: "${{ inputs.mode }}",
      CI_EVIDENCE_DISPATCH_BASE: "${{ inputs.base_sha }}",
      CI_EVIDENCE_DISPATCH_HEAD: "${{ inputs.head_sha }}",
    }, run: "node scripts/ci/ci-evidence.mjs produce" },
    { name: "Keep the proof", if: pr, uses: EV_UPLOAD, with: {
      name: "relayium-ci-evidence-proof-attempt-${{ github.run_attempt }}",
      path: "${{ runner.temp }}/ci-evidence/ci-evidence.json", "if-no-files-found": "ignore", "retention-days": "7",
    } },
  ];
  need(steps.length === 1 + want.length && String(steps[0]?.run ?? "").includes("CONDITIONAL_LANES")
    && steps[0]?.if === undefined && deepEqual(steps.slice(1), want), `${AGGREGATE}/${GATE_JOB}: the steps after `
    + `the judgement are not the canonical proof producer.\n  got:  ${JSON.stringify(steps.slice(1))}\n`
    + `  want: ${JSON.stringify(want)}\nThe proof may be minted only after every lane is judged, only on a pull `
    + "request, only by the verifier whose tests just passed, and only under its attempt-scoped name.");

  // Every other workflow that calls an adopted lane must grant the same, or it
  // fails to start the moment the callee carries an evidence job.
  const adoptedFiles = new Map(Object.entries(registry.lanes).map(([id, l]) => [`./.github/workflows/${l.workflow}`, id]));
  for (const [file, doc] of world.docs) {
    if (file === AGGREGATE) continue;
    for (const [jobId, j] of Object.entries(doc?.jobs ?? {})) {
      if (!adoptedFiles.has(j?.uses)) continue;
      const key = `${file}/${jobId}`;
      const granted = deepEqual(j.permissions, EV_GRANTS);
      if (EVIDENCE_CALLER_GRANT_PENDING[key]) {
        need(!granted, `6x: ${key} now grants the evidence permissions; remove it from EVIDENCE_CALLER_GRANT_PENDING.`);
        world.pendingCallers?.push(key);
        continue;
      }
      need(granted, `${key}: calls ${j.uses} (an evidence lane) with permissions ${JSON.stringify(j.permissions)}; `
        + `want exactly ${JSON.stringify(EV_GRANTS)}. A caller that grants less makes the run fail to start.`);
    }
  }
  for (const key of Object.keys(EVIDENCE_CALLER_GRANT_PENDING)) {
    const [file, jobId] = key.split("/");
    need(adoptedFiles.has(world.docs.get(file)?.jobs?.[jobId]?.uses),
      `6x: EVIDENCE_CALLER_GRANT_PENDING names ${key}, which no longer calls an evidence lane; remove the entry.`);
  }

  // The verifier's own suite runs, whole and unconditionally, on every main push:
  // repo-hygiene has no path filter, and a scope variable here would skip the
  // guard-projection controls on the one event direct-to-main delivery has.
  const hygiene = world.docs.get("repo-hygiene.yml");
  const unitSteps = Object.values(hygiene?.jobs ?? {}).flatMap((j) => (j?.steps ?? []).map((st) => ({ j, st })))
    .filter(({ st }) => st?.run === "node scripts/test/ci-evidence-test.mjs");
  need(unitSteps.length === 1 && unitSteps.every(({ j, st }) => j.if === undefined && st.if === undefined
    && st.env === undefined && st["continue-on-error"] === undefined && j["continue-on-error"] === undefined),
  "repo-hygiene.yml: want exactly one unconditional `node scripts/test/ci-evidence-test.mjs` step with no env, so "
    + "the verifier and its guard-projection controls run in full on every pull request and every main push.");
  // Every guard that judges a lane through the projection reads it through
  // `fullPathOf` — the one function whose controls prove it hides nothing else.
  for (const [file, text] of world.guardTexts) {
    need(/import \{ fullPathOf \} from "\.\.\/ci\/ci-evidence-view\.mjs";/.test(text) && /fullPathOf\(/.test(text.replace(/^import .*$/m, "")),
      `${file}: does not read workflows through fullPathOf from scripts/ci/ci-evidence-view.mjs, so its rules judge the `
      + "witness path instead of the full path — or skip the projection's own controls.");
  }

  for (const input of EVIDENCE_INPUTS) {
    need(world.controlFiles.includes(input), `${SELECTOR}: CONTROL_FILES does not name ${input}, so a pull request `
      + "that edits the verifier would be judged by a partial run while minting a proof for every lane.");
  }
  return out;
}

/** The raw text of a lane workflow, as read from disk before any projection. */
const evidenceRawTexts = new Map();
for (const lane of Object.values(evidenceRegistry?.lanes ?? {})) {
  try {
    evidenceRawTexts.set(lane.workflow, readFileSync(resolve(workflowsDir, lane.workflow), "utf8"));
  } catch { /* reported as missing by the governed-file loader */ }
}
/** The six policy tests that judge adopted lanes through the full-path projection. */
const EVIDENCE_PROJECTED_GUARDS = ["contract-ci-policy", "swift-ci-boundary", "web-lane-scope", "ui-test-budget",
  "native-web-pairing-gate", "cli-interop-matrix"].map((g) => `scripts/test/${g}-test.mjs`);
const evidenceGuardTexts = new Map(EVIDENCE_PROJECTED_GUARDS.map((f) => {
  try { return [f, readFileSync(resolve(repoRoot, f), "utf8")]; } catch { return [f, ""]; }
}));

function evidenceWorld() {
  return {
    guardTexts: new Map(evidenceGuardTexts),
    texts: new Map(evidenceRawTexts),
    docs: new Map([...docs].map(([file, doc]) => [file, structuredClone(doc)])),
    evidenceRegistry: structuredClone(evidenceRegistry),
    toolReg: structuredClone(evidenceToolchain),
    controlFiles: [...SELECTOR_CONTROL_FILES],
  };
}

/**
 * Rewrite exactly one occurrence of `from` in a lane's TEXT and re-parse it, so a
 * mutation is a consistent source edit rather than a parsed-document patch. A
 * stale anchor throws instead of passing as a no-op.
 */
function evRewrite(w, file, from, to) {
  const text = w.texts.get(file);
  const n = text.split(from).length - 1;
  if (n !== 1) throw new Error(`stale anchor in ${file}: ${JSON.stringify(from.slice(0, 80))} occurs ${n} time(s)`);
  const next = text.replace(from, to);
  w.texts.set(file, next);
  w.docs.set(file, parseYaml(next));
}

/**
 * Edit a lane's FULL PATH (the original workflow, as `fullPathText` projects it
 * from the real adopted text under this world's registries) exactly once, then
 * re-adopt it canonically and re-parse: the mutant is what the generator itself
 * would write for that source edit, so only a rule about the edit can refuse it.
 * A text that is not canonical, or a stale anchor, throws.
 */
function evFullPathRewrite(w, file, laneId, from, to) {
  const lane = w.evidenceRegistry.lanes[laneId];
  const raw = w.texts.get(file);
  const full = fullPathText(raw, laneId, lane, w.toolReg);
  if (full === raw) throw new Error(`${file} is not the canonical adoption of a full path`);
  const n = full.split(from).length - 1;
  if (n !== 1) throw new Error(`stale anchor in ${file}'s full path: ${JSON.stringify(from.slice(0, 80))} occurs ${n} time(s)`);
  const next = adoptText(full.replace(from, to), laneId, lane, w.toolReg);
  w.texts.set(file, next);
  w.docs.set(file, parseYaml(next));
}

const EVIDENCE_MUTATIONS = [
  ["an original step loses its evidence guard", (w) => { delete w.docs.get("go.yml").jobs["race-account"].steps.find((st) => /^go test -race/.test(st.name ?? "")).if; },
    /go\.yml \(evidence lane go\)\/race-account: step .* carries `if: \(none\)`/],
  ["a guard is composed so it can skip on the full path", (w) => {
    const step = w.docs.get("compat.yml").jobs["wire-vectors"].steps.find((st) => /^Regenerate the cross-language/.test(st.name ?? ""));
    step.if = `${EV_FULL} || github.actor == 'x'`;
  }, /compat\.yml \(evidence lane compat\)\/wire-vectors: step .* carries `if: needs\.evidence/],
  ["a failure artifact runs on the witness path", (w) => {
    const step = w.docs.get("go.yml").jobs.test.steps.find((s) => s.name === "Keep the CLI matrix log (on failure)");
    step.if = "failure()";
  }, /go\.yml \(evidence lane go\)\/test: step "Keep the CLI matrix log \(on failure\)" carries `if: failure\(\)`/],
  ["a macOS job falls back to Ubuntu on the full path", (w) => {
    w.docs.get("ios.yml").jobs["ios-ipad-shell"]["runs-on"] = `\${{ ${EV_WITNESS} && 'ubuntu-latest' || 'ubuntu-latest' }}`;
  }, /ios\.yml \(evidence lane ios\)\/ios-ipad-shell: runs-on is/],
  ["a Windows job loses its runner ternary", (w) => { w.docs.get("go.yml").jobs["cli-windows"]["runs-on"] = "ubuntu-latest"; },
    /go\.yml \(evidence lane go\)\/cli-windows: runs-on is "ubuntu-latest"/],
  ["a job stops needing the evidence job", (w) => { w.docs.get("swift-package.yml").jobs["swift-test"].needs = undefined; },
    /swift-package\.yml \(evidence lane swift-package\)\/swift-test: does not `needs: evidence`/],
  ["the confirm step vouches for another lane", (w) => {
    w.docs.get("contracts.yml").jobs["swift-contract"].steps[2].run = "node scripts/ci/ci-evidence.mjs confirm ios";
  }, /contracts\.yml \(evidence lane contracts\)\/swift-contract: does not open with the three canonical witness steps/],
  ["the confirm step becomes advisory", (w) => {
    w.docs.get("ios.yml").jobs["ios-build"].steps[2]["continue-on-error"] = "true";
  }, /ios\.yml \(evidence lane ios\)\/ios-build: does not open with the three canonical witness steps/],
  ["the evidence job decides on a pull request", (w) => {
    w.docs.get("go.yml").jobs.evidence.steps.find((st) => st.id === "verify").if = "always()";
  }, /go\.yml \(evidence lane go\): the `evidence` job is not the canonical one/],
  ["the evidence job gains a secret", (w) => {
    w.docs.get("macos.yml").jobs.evidence.steps.find((st) => st.id === "verify").env.TOKEN = "${{ secrets.MACOS_SIGNING_CERT_PASSWORD }}";
  }, /macos\.yml \(evidence lane macos\): the `evidence` job is not the canonical one/],
  ["the evidence job gains a write grant", (w) => { w.docs.get("web.yml").jobs.evidence.permissions.actions = "write"; },
    /web\.yml \(evidence lane web\): the `evidence` job is not the canonical one/],
  ["the web witness forgets the main scope", (w) => { delete w.docs.get("web.yml").jobs.evidence.steps.find((st) => st.id === "verify").env.CI_EVIDENCE_SCOPE_LIGHT; },
    /web\.yml \(evidence lane web\): the `evidence` job is not the canonical one/],
  ["the fresh signed build reads the decision", (w) => {
    w.docs.get("macos.yml").jobs["signed-build"].steps[0].if = EV_FULL;
  }, /macos\.yml \(evidence lane macos\)\/signed-build: is registered fresh but reads the evidence decision/],
  ["a macOS job is given a fresh step", (w) => {
    w.evidenceRegistry.lanes.ios.jobs["ios-build"].freshSteps = ["Select and verify the Xcode 26 upload toolchain"];
  }, /ios\.yml \(evidence lane ios\)\/ios-build: keeps steps fresh on/],
  ["a fresh step name drifts", (w) => { w.evidenceRegistry.lanes.go.jobs.test.freshSteps.push("govulncheck v2"); },
    /go\.yml \(evidence lane go\)\/test: registry fresh step "govulncheck v2" matches 0 steps/],
  ["the registry loses a job", (w) => { delete w.evidenceRegistry.lanes.ios.jobs["ios-ipad-shell"]; },
    /ios\.yml \(evidence lane ios\): declares jobs .* the evidence registry lists/],
  ["a matrix check name drifts", (w) => { w.evidenceRegistry.lanes.go.jobs["race-account"].checks[7] = "race account shard 8"; },
    /go\.yml \(evidence lane go\)\/race-account: GitHub names this job's checks/],
  ["a truncated matrix name drifts", (w) => {
    w.docs.get("macos.yml").jobs["ui-smoke"].strategy.matrix.include[1].shard = "inbox";
  }, /macos\.yml \(evidence lane macos\)\/ui-smoke: GitHub names this job's checks/],
  ["a lane loses an evidence input from its filter", (w) => {
    const on = w.docs.get("ios.yml").on.push;
    on.paths = on.paths.filter((p) => p !== "scripts/ci/ci-evidence.mjs");
  }, /ios\.yml \(evidence lane ios\): `push\.paths` does not name scripts\/ci\/ci-evidence\.mjs/],
  ["the main-push trigger is dropped", (w) => { delete w.docs.get("android.yml").on.push.branches; },
    /android\.yml \(evidence lane android\): `on\.push\.branches` is not exactly \[main\]/],
  ["a new gate lane is neither adopted nor excused", (w) => { delete w.evidenceRegistry.lanes.android; },
    /6x: lane android is neither in the evidence registry nor excused/],
  ["a caller grant widens", (w) => { w.docs.get(AGGREGATE).jobs.ios.permissions.actions = "write"; },
    /merge-gate\.yml\/ios: permissions are/],
  ["an excused lane gains grants", (w) => { w.docs.get(AGGREGATE).jobs.windows.permissions = { ...EV_GRANTS }; },
    /merge-gate\.yml\/windows: carries permissions/],
  ["the producer runs on a dispatch", (w) => { delete w.docs.get(AGGREGATE).jobs[GATE_JOB].steps[4].if; },
    /merge-gate\.yml\/merge-gate: the steps after the judgement are not the canonical proof producer/],
  ["the producer runs before the judgement", (w) => {
    const steps = w.docs.get(AGGREGATE).jobs[GATE_JOB].steps;
    steps.push(steps.shift());
  }, /merge-gate\.yml\/merge-gate: the steps after the judgement are not the canonical proof producer/],
  ["the proof name loses its attempt", (w) => {
    w.docs.get(AGGREGATE).jobs[GATE_JOB].steps[5].with.name = "relayium-ci-evidence-proof";
  }, /merge-gate\.yml\/merge-gate: the steps after the judgement are not the canonical proof producer/],
  // ── the toolchain certificate's place in the adoption ──
  ["a failed certify job can skip the evidence job", (w) => { delete w.docs.get("ios.yml").jobs.evidence.if; },
    /ios\.yml \(evidence lane ios\): the `evidence` job is not the canonical one/],
  ["a certify job runs on pull requests", (w) => { delete w.docs.get("swift-package.yml").jobs["certify-macos"].if; },
    /swift-package\.yml \(evidence lane swift-package\): the `certify-macos` job is not the canonical one/],
  ["a slow probe turns main red", (w) => { delete w.docs.get("go.yml").jobs["certify-windows"]["continue-on-error"]; },
    /go\.yml \(evidence lane go\): the `certify-windows` job is not the canonical one/],
  ["a certify job loses its time bound", (w) => { w.docs.get("ios.yml").jobs["certify-macos"]["timeout-minutes"] = "30"; },
    /ios\.yml \(evidence lane ios\): the `certify-macos` job is not the canonical one/],
  ["a certify job gains a secret", (w) => {
    w.docs.get("macos.yml").jobs["certify-macos"].steps[1].env = { P: "${{ secrets.MACOS_SIGNING_CERT_PASSWORD }}" };
  }, /macos\.yml \(evidence lane macos\): the `certify-macos` job is not the canonical one/],
  ["the iOS probe forgets the lane's Xcode selection", (w) => {
    w.docs.get("ios.yml").jobs["certify-macos"].steps = w.docs.get("ios.yml").jobs["certify-macos"].steps.filter((st) => !/^Select/.test(st.name ?? ""));
  }, /ios\.yml \(evidence lane ios\)\/ios-build: its "Select and verify the Xcode 26 upload toolchain" step is not exactly copied/],
  ["a job's setup differs from the probe's", (w) => {
    w.docs.get("web.yml").jobs["mixed-link-e2e"].steps.find((st) => st.name === undefined && /^actions\/setup-node/.test(st.uses ?? "")).with["node-version"] = "22";
  }, /web\.yml \(evidence lane web\)\/mixed-link-e2e: its "actions\/setup-node" step is not exactly copied/],
  ["the Android probe skips the job's SDK install", (w) => {
    w.docs.get("android.yml").jobs.evidence.steps = w.docs.get("android.yml").jobs.evidence.steps.filter((st) => st.name !== "Install the pinned SDK platform");
  }, /android\.yml \(evidence lane android\)\/build: its "Install the pinned SDK platform" step is not exactly copied/],
  ["a certified job loses its capture", (w) => { w.docs.get("go.yml").jobs["race-rest"].steps.splice(-2, 2); },
    /go\.yml \(evidence lane go\)\/race-rest: does not end with the canonical toolchain capture for profile linux-go/],
  ["a job is captured under another profile", (w) => {
    w.docs.get("compat.yml").jobs["android-protocol"].steps.at(-2).run = w.docs.get("compat.yml").jobs["android-protocol"].steps.at(-2).run.replace("linux-java", "linux-base");
  }, /compat\.yml \(evidence lane compat\)\/android-protocol: does not end with the canonical toolchain capture/],
  ["the capture runs on the witness path", (w) => { delete w.docs.get("ios.yml").jobs["ios-ipad-shell"].steps.at(-2).if; },
    /ios\.yml \(evidence lane ios\)\/ios-ipad-shell: does not end with the canonical toolchain capture/],
  ["an uncertifiable job captures anyway", (w) => {
    w.docs.get("android-interop.yml").jobs.interop.steps.push({ name: "Certify this job's toolchain", run: "true" });
  }, /android-interop\.yml \(evidence lane android-interop\)\/interop: is uncertifiable but captures/],
  ["a reusable job has no toolchain entry", (w) => { delete w.toolReg.lanes.contracts.jobs["web-contract"]; },
    /contracts\.yml \(evidence lane contracts\): its toolchain plan cannot be derived \(contracts\/web-contract has no toolchain entry\)/],
  ["a stray certify job", (w) => { w.docs.get("android.yml").jobs["certify-macos"] = { "runs-on": "macos-15" }; },
    /android\.yml \(evidence lane android\): declares certify-macos, a certify job no certified job/],
  ["another workflow calls a lane without the grants", (w) => {
    w.docs.get(MACOS_RELEASE).jobs.extra = { uses: "./.github/workflows/go.yml" };
  }, /macos-release\.yml\/extra: calls \.\/\.github\/workflows\/go\.yml \(an evidence lane\)/],
  ["the macOS release caller loses a grant", (w) => {
    const { "pull-requests": _, ...rest } = w.docs.get(MACOS_RELEASE).jobs.build.permissions;
    w.docs.get(MACOS_RELEASE).jobs.build.permissions = rest;
  }, /macos-release\.yml\/build: calls \.\/\.github\/workflows\/macos\.yml \(an evidence lane\)/],
  ["the adoption transform stops being a control file", (w) => { w.controlFiles = w.controlFiles.filter((f) => f !== "scripts/ci/ci-evidence-view.mjs"); },
    /CONTROL_FILES does not name scripts\/ci\/ci-evidence-view\.mjs/],
  ["the verifier's tests stop being a control file", (w) => { w.controlFiles = w.controlFiles.filter((f) => f !== "scripts/test/ci-evidence-test.mjs"); },
    /CONTROL_FILES does not name scripts\/test\/ci-evidence-test\.mjs/],
  ["a lane loses the verifier's tests from its filter", (w) => {
    const on = w.docs.get("go.yml").on.push;
    on.paths = on.paths.filter((p) => p !== "scripts/test/ci-evidence-test.mjs");
  }, /go\.yml \(evidence lane go\): `push\.paths` does not name scripts\/test\/ci-evidence-test\.mjs/],
  ["main stops running the verifier suite", (w) => {
    for (const j of Object.values(w.docs.get("repo-hygiene.yml").jobs)) {
      j.steps = (j.steps ?? []).filter((st) => st?.run !== "node scripts/test/ci-evidence-test.mjs");
    }
  }, /want exactly one unconditional `node scripts\/test\/ci-evidence-test\.mjs` step/],
  ["main runs only the verifier half", (w) => {
    for (const j of Object.values(w.docs.get("repo-hygiene.yml").jobs)) {
      for (const st of j.steps ?? []) if (st?.run === "node scripts/test/ci-evidence-test.mjs") st.env = { CI_EVIDENCE_TEST_SCOPE: "verifier" };
    }
  }, /want exactly one unconditional/],
  ["a guard reads lanes raw again", (w) => {
    const f = "scripts/test/web-lane-scope-test.mjs";
    w.guardTexts.set(f, w.guardTexts.get(f).replace(/fullPathOf\("web\.yml", (readFileSync\([^)]*\), "utf8"\))\)/, "$1"));
  }, /web-lane-scope-test\.mjs: does not read workflows through fullPathOf/],
  ["the verifier stops being a control file", (w) => { w.controlFiles = w.controlFiles.filter((f) => f !== "scripts/ci/ci-evidence.mjs"); },
    /CONTROL_FILES does not name scripts\/ci\/ci-evidence\.mjs/],
  // ── revision 3: the screen, the execution graph and the frozen dispatch ──
  ["the screen gains a write grant", (w) => { w.docs.get("ios.yml").jobs.screen.permissions.actions = "write"; },
    /ios\.yml \(evidence lane ios\): the `screen` job is not the canonical one/],
  ["the screen can turn main red", (w) => { delete w.docs.get("go.yml").jobs.screen["continue-on-error"]; },
    /go\.yml \(evidence lane go\): the `screen` job is not the canonical one/],
  ["the screen runs on pull requests", (w) => { w.docs.get("contracts.yml").jobs.screen.if = "${{ !cancelled() }}"; },
    /contracts\.yml \(evidence lane contracts\): the `screen` job is not the canonical one/],
  ["a lane with no paid probe grows a screen", (w) => { w.docs.get("compat.yml").jobs.screen = structuredClone(w.docs.get("go.yml").jobs.screen); },
    /compat\.yml \(evidence lane compat\): declares a `screen` job but has no paid certify job/],
  ["a certify job stops waiting for the screen", (w) => { delete w.docs.get("macos.yml").jobs["certify-macos"].needs; },
    /macos\.yml \(evidence lane macos\): the `certify-macos` job is not the canonical one/],
  ["a certify job ignores the screen's verdict", (w) => { w.docs.get("web.yml").jobs["certify-windows"].if = `\${{ !cancelled() && ${EV_MAIN_PUSH} }}`; },
    /web\.yml \(evidence lane web\): the `certify-windows` job is not the canonical one/],
  ["the evidence job's outputs bypass the handover", (w) => { w.docs.get("contracts.yml").jobs.evidence.outputs.reuse = "${{ steps.verify.outputs.reuse }}"; },
    /contracts\.yml \(evidence lane contracts\): the `evidence` job is not the canonical one/],
  ["the handover stops checking the upload's outcome", (w) => {
    w.docs.get("android.yml").jobs.evidence.steps.find((st) => st.id === "handover").if = "steps.verify.outputs.reuse == 'true'";
  }, /android\.yml \(evidence lane android\): the `evidence` job is not the canonical one/],
  ["the evidence job can turn main red", (w) => { delete w.docs.get("android.yml").jobs.evidence["continue-on-error"]; },
    /android\.yml \(evidence lane android\): the `evidence` job is not the canonical one/],
  ["the evidence job stops waiting for the screen", (w) => { w.docs.get("ios.yml").jobs.evidence.needs = ["certify-macos"]; },
    /ios\.yml \(evidence lane ios\): the `evidence` job is not the canonical one/],
  ["an original job falls back to implicit success()", (w) => { delete w.docs.get("go.yml").jobs["race-rest"].if; },
    /go\.yml \(evidence lane go\)\/race-rest: the job condition is null, want exactly "\$\{\{ !cancelled\(\) \}\}"/],
  ["an original job's condition forgets one of its needs", (w) => {
    w.docs.get("macos.yml").jobs["ui-smoke"].if = w.docs.get("macos.yml").jobs["ui-smoke"].if.replace(" && needs.contract.result == 'success'", "");
  }, /macos\.yml \(evidence lane macos\)\/ui-smoke: the job condition is/],
  // Consistent source-level edits: the TEXT is changed (so its full path and the
  // adoption round trip agree with it) and re-parsed, so every generic check that
  // derives the condition from the job's own needs is satisfied. Only the explicit
  // macOS order assertion can refuse them.
  ["ui-smoke consistently waits for test again (needs AND condition)", (w) => {
    const ui = "  ui-smoke:\n    needs: [contract, evidence]\n    if: ${{ !cancelled() && needs.contract.result == 'success' && (";
    evRewrite(w, "macos.yml", ui, ui.replace("[contract, evidence]", "[test, contract, evidence]")
      .replace("!cancelled() && needs.contract.result", "!cancelled() && needs.test.result == 'success' && needs.contract.result"));
  }, /macos\.yml \(evidence lane macos\)\/ui-smoke: needs \["test","contract"\] \(adopted \["test","contract","evidence"\]\), want exactly \["contract"\]/],
  // Built through the full path, not by patching adopted text: `contract` is
  // always fresh, so once signed-build stops needing `test` it has no witnessable
  // ancestor left and the generator writes its condition differently. Only the
  // generator knows that; the source edit is the one dependency (the full-path
  // condition never named `test`).
  ["signed-build consistently stops waiting for test (needs AND condition)", (w) => {
    evFullPathRewrite(w, "macos.yml", "macos", "  signed-build:\n    needs: [test, contract]\n", "  signed-build:\n    needs: contract\n");
  }, /macos\.yml \(evidence lane macos\)\/signed-build: needs \["contract"\] \(adopted \["contract"\]\), want exactly \["test","contract"\]/],
  ["an original job's own condition is dropped", (w) => { w.docs.get("web.yml").jobs.test.if = "${{ !cancelled() && needs.scope.result == 'success' }}"; },
    /web\.yml \(evidence lane web\)\/test: the job condition is/],
  ["a fresh job downstream of a witness stays on implicit success()", (w) => {
    w.docs.get("macos.yml").jobs["signed-build"].if = "github.event_name != 'pull_request' || github.event.pull_request.head.repo.full_name == github.repository";
  }, /macos\.yml \(evidence lane macos\)\/signed-build: the job condition is/],
  ["the producer runs on the pull-request dispatch mode", (w) => {
    for (const st of w.docs.get(AGGREGATE).jobs[GATE_JOB].steps.slice(1)) st.if = "github.event_name == 'pull_request' || github.event_name == 'workflow_dispatch'";
  }, /merge-gate\.yml\/merge-gate: the steps after the judgement are not the canonical proof producer/],
  ["the producer loses the dispatched base", (w) => { delete w.docs.get(AGGREGATE).jobs[GATE_JOB].steps[4].env.CI_EVIDENCE_DISPATCH_BASE; },
    /merge-gate\.yml\/merge-gate: the steps after the judgement are not the canonical proof producer/],
  ["the producer stops running on the internal full candidate", (w) => {
    for (const st of w.docs.get(AGGREGATE).jobs[GATE_JOB].steps.slice(1)) {
      st.if = "github.event_name == 'pull_request' || (github.event_name == 'workflow_dispatch' && inputs.mode == 'frozen-release-metadata')";
    }
  }, /merge-gate\.yml\/merge-gate: the steps after the judgement are not the canonical proof producer/],
  ["a new dispatch mode inherits the producer", (w) => { w.docs.get(AGGREGATE).on.workflow_dispatch.inputs.mode.options.push("hotfix"); },
    /merge-gate\.yml: the dispatch modes are .*want exactly \[pull-request, frozen-release-metadata, internal-full-candidate, full-bootstrap\]/],
  ["the producer runs on the full bootstrap", (w) => {
    for (const st of w.docs.get(AGGREGATE).jobs[GATE_JOB].steps.slice(1)) {
      st.if = st.if.replace("inputs.mode == 'internal-full-candidate'", "inputs.mode == 'internal-full-candidate' || inputs.mode == 'full-bootstrap'");
    }
  }, /merge-gate\.yml\/merge-gate: the steps after the judgement are not the canonical proof producer/],
  ["a lane loses the toolchain registry from its filter", (w) => {
    const on = w.docs.get("ios.yml").on.push;
    on.paths = on.paths.filter((p) => p !== "scripts/ci/ci-evidence-toolchain-registry.json");
  }, /ios\.yml \(evidence lane ios\): `push\.paths` does not name scripts\/ci\/ci-evidence-toolchain-registry\.json/],
];

// ── 6x graph. what actually RUNS, by outcome ───────────────────────────────
//
// The canonical shape is necessary, not sufficient: "no proof ⇒ full" is a
// property of the job GRAPH — of which jobs GitHub starts given how their
// dependencies ended. So each adopted lane's real job graph is evaluated here,
// job-level `if:` expressions included, under the outcomes that matter: no
// eligible proof, an eligible one, a failed or timed-out screen, a skipped
// screen (the preflight), a failed certify job, an evidence job whose setup
// failed or which timed out. GitHub's implicit `success()` is modelled
// PESSIMISTICALLY (every transitive ancestor must have succeeded, a skipped one
// counts against it), and a `continue-on-error` job that failed is evaluated
// both ways GitHub might report it to `needs`. Every original job must then run
// — on its original runner unless the decision is exactly 'true' — no paid
// probe may start without an eligible screen, and nothing but an original job
// may turn the run red.

/** A GitHub expression, evaluated over `ctx`; unknown syntax or identifiers throw. */
function evalGhExpression(text, ctx, status) {
  const src = String(text).trim().replace(/^\$\{\{([\s\S]*)\}\}$/, "$1");
  const toks = [];
  const re = /\s*(?:('(?:[^']|'')*')|(\d+(?:\.\d+)?)|([A-Za-z_][A-Za-z0-9_-]*)|(==|!=|&&|\|\||[!().,[\]]))/y;
  let at = 0;
  while (at < src.length) {
    if (/^\s*$/.test(src.slice(at))) break;
    re.lastIndex = at;
    const m = re.exec(src);
    if (!m) throw new Error(`unparsable expression at ${JSON.stringify(src.slice(at, at + 20))}`);
    at = re.lastIndex;
    toks.push(m[1] !== undefined ? { s: m[1].slice(1, -1).replace(/''/g, "'") } : m[2] !== undefined ? { n: Number(m[2]) }
      : m[3] !== undefined ? { id: m[3] } : { p: m[4] });
  }
  let i = 0;
  const peek = (p) => toks[i]?.p === p;
  const take = (p) => { if (!peek(p)) throw new Error(`expected ${p} in ${src}`); i += 1; };
  const truthy = (v) => !(v === false || v === null || v === undefined || v === "" || v === 0 || Number.isNaN(v));
  const num = (v) => (v === null || v === undefined ? 0 : typeof v === "boolean" ? Number(v) : typeof v === "number" ? v
    : String(v).trim() === "" ? 0 : Number(v));
  const eq = (a, b) => {
    if (typeof a === "string" && typeof b === "string") return a.toLowerCase() === b.toLowerCase();
    if (typeof a === typeof b && a !== null && b !== null) return a === b;
    return num(a) === num(b);
  };
  const FUNCS = {
    always: () => true, cancelled: () => false, success: () => status.success, failure: () => status.failure,
    contains: (a, b) => (Array.isArray(a) ? a.some((x) => eq(x, b)) : String(a ?? "").toLowerCase().includes(String(b ?? "").toLowerCase())),
    fromJSON: (x) => JSON.parse(x),
  };
  const or = () => { let v = and(); while (peek("||")) { i += 1; const r = and(); v = truthy(v) ? v : r; } return v; };
  const and = () => { let v = unary(); while (peek("&&")) { i += 1; const r = unary(); v = truthy(v) ? r : v; } return v; };
  const unary = () => { if (peek("!")) { i += 1; return !truthy(unary()); } return cmp(); };
  const cmp = () => {
    const a = primary();
    if (peek("==") || peek("!=")) { const op = toks[i].p; i += 1; const b = primary(); return op === "==" ? eq(a, b) : !eq(a, b); }
    return a;
  };
  const primary = () => {
    const t = toks[i];
    if (!t) throw new Error(`truncated expression ${src}`);
    if (t.p === "(") { i += 1; const v = or(); take(")"); return v; }
    i += 1;
    if (t.s !== undefined) return t.s;
    if (t.n !== undefined) return t.n;
    if (t.id === "true" || t.id === "false") return t.id === "true";
    if (t.id === "null") return null;
    if (peek("(")) {
      i += 1;
      const args = [];
      while (!peek(")")) { args.push(or()); if (peek(",")) i += 1; }
      take(")");
      if (!FUNCS[t.id]) throw new Error(`unmodelled function ${t.id}()`);
      return FUNCS[t.id](...args);
    }
    if (!Object.hasOwn(ctx, t.id)) throw new Error(`unmodelled context ${t.id}`);
    let v = ctx[t.id];
    for (;;) {
      if (peek(".")) { i += 1; const k = toks[i++]?.id; v = v == null ? null : v[k] ?? null; continue; }
      if (peek("[")) { i += 1; const k = or(); take("]"); v = v == null ? null : v[k] ?? null; continue; }
      return v;
    }
  };
  const v = or();
  if (i !== toks.length) throw new Error(`trailing tokens in ${src}`);
  return v;
}

const STATUS_FN = /\b(?:always|success|failure|cancelled)\s*\(/;

/**
 * The lane's jobs as GitHub would run them under `scenario`: per job, whether it
 * started, its result as `needs` sees it, its outputs and its runner.
 */
function evalLaneGraph(doc, scenario, coeFailureReportsAs) {
  const jobs = doc.jobs ?? {};
  const needsOf = (id) => (Array.isArray(jobs[id]?.needs) ? jobs[id].needs : jobs[id]?.needs === undefined ? [] : [jobs[id].needs]);
  const state = new Map();
  const ancestors = (id, seen = new Set()) => { for (const n of needsOf(id)) if (!seen.has(n)) { seen.add(n); ancestors(n, seen); } return seen; };
  const github = { event_name: scenario.event, ref: scenario.ref, repository: "relayium/relayium",
    event: { pull_request: scenario.event === "pull_request" ? { head: { repo: { full_name: scenario.headRepo ?? "relayium/relayium" } } } : null } };
  const visit = (id) => {
    if (state.has(id)) return state.get(id);
    for (const n of needsOf(id)) visit(n);
    const needs = Object.fromEntries(needsOf(id).map((n) => [n, { result: state.get(n).reported, outputs: state.get(n).outputs }]));
    const anc = [...ancestors(id)].map((a) => state.get(a).reported);
    const status = { success: anc.every((r) => r === "success"), failure: anc.some((r) => r === "failure") };
    const cond = jobs[id].if;
    const ctx = { github, needs, inputs: scenario.inputs ?? {}, vars: {} };
    const runs = cond === undefined ? status.success
      : STATUS_FN.test(String(cond)) ? Boolean(evalGhExpression(cond, ctx, status))
        : status.success && Boolean(evalGhExpression(cond, ctx, status));
    let result = "skipped";
    let outputs = {};
    if (runs && id === "evidence" && scenario.jobs?.evidence === undefined) {
      ({ result, outputs } = evalEvidenceSteps(jobs[id], scenario, { github, needs, inputs: scenario.inputs ?? {}, vars: {} }));
    } else if (runs) {
      const o = scenario.jobs?.[id] ?? {};
      result = o.result ?? "success";
      outputs = result === "success" ? (o.outputs ?? scenario.defaultOutputs?.(id) ?? {}) : {};
    }
    const coe = String(jobs[id]["continue-on-error"] ?? "") === "true";
    const reported = result === "failure" && coe ? coeFailureReportsAs : result;
    const runsOn = runs ? String(jobs[id]["runs-on"]).includes("${{")
      ? evalGhExpression(jobs[id]["runs-on"], { github, needs, inputs: scenario.inputs ?? {}, vars: {} }, status) : jobs[id]["runs-on"] : null;
    const st = { runs, result, reported, outputs, runsOn, red: result === "failure" && !coe };
    state.set(id, st);
    return st;
  };
  for (const id of Object.keys(jobs)) visit(id);
  return state;
}

/**
 * The evidence job, step by step: each step's `if:` over the steps before it
 * (implicit success() at step level), a step outcome or a timeout from the
 * scenario, and the job's `outputs:` evaluated over what the steps produced —
 * also when the job failed or was killed, which is the pessimistic reading.
 */
function evalEvidenceSteps(job, scenario, base) {
  const steps = {};
  let failed = false;
  let killed = false;
  for (const st of job.steps ?? []) {
    const key = st.id ?? st.name ?? String(st.uses ?? st.run);
    if (killed) { if (st.id) steps[st.id] = { outcome: "", conclusion: "", outputs: {} }; continue; }
    const status = { success: !failed, failure: failed };
    const ctx = { ...base, steps };
    const cond = st.if;
    const runs = cond === undefined ? !failed : STATUS_FN.test(String(cond)) ? Boolean(evalGhExpression(cond, ctx, status))
      : !failed && Boolean(evalGhExpression(cond, ctx, status));
    let outcome = "skipped";
    let outputs = {};
    if (runs) {
      if (scenario.evidenceTimeoutAt !== undefined && scenario.evidenceTimeoutAt === key) { killed = true; failed = true; outcome = "failure"; }
      else {
        outcome = scenario.stepOutcome?.[key] ?? "success";
        if (outcome === "failure") failed = true;
        else outputs = scenario.stepOutputs?.[key] ?? (key === "verify" ? { reuse: scenario.verdict ?? "", witness: scenario.verdict === "true" ? "{}" : "" }
          : key === "handover" ? { reuse: "true", witness: "{}" } : {});
      }
    }
    if (st.id) steps[st.id] = { outcome, conclusion: outcome, outputs };
  }
  const outputs = Object.fromEntries(Object.entries(job.outputs ?? {}).map(([k, expr]) => {
    const v = evalGhExpression(expr, { ...base, steps }, { success: !failed, failure: failed });
    return [k, v === null || v === undefined ? "" : String(v)];
  }));
  return { result: failed ? "failure" : "success", outputs };
}

/** Every graph failure of one lane under every scenario, as messages. */
function evidenceGraphFailures(world) {
  const out = [];
  const registry = world.evidenceRegistry;
  for (const [laneId, lane] of Object.entries(registry?.lanes ?? {})) {
    const doc = world.docs.get(lane.workflow);
    if (!doc?.jobs?.evidence) continue;
    const where = `${lane.workflow} (evidence lane ${laneId})`;
    const paid = Object.keys(doc.jobs).filter((j) => /^certify-/.test(j));
    const originals = Object.keys(lane.jobs);
    const main = { event: "push", ref: "refs/heads/main" };
    const dflt = (reuse, eligible) => (id) => (id === "evidence" ? { reuse, witness: reuse === "true" ? "{}" : "" }
      : id === "screen" ? { eligible } : /^certify-/.test(id) ? { certificates: "{}" }
        : lane.scope && id === lane.scope.job ? { [lane.scope.output]: "true" } : {});
    const failed = (...ids) => Object.fromEntries(ids.map((id) => [id, { result: "failure" }]));
    const eligible = { ...main, verdict: "true", defaultOutputs: dflt("true", "true") };
    const firstSetup = (doc.jobs.evidence.steps ?? []).find((st) => /^Node for the verifier/.test(st.name ?? ""))?.name;
    const SCENARIOS = [
      ["a pull request", { event: "pull_request", ref: "refs/pull/1/merge", defaultOutputs: dflt("", "") }, { paid: 0, witness: false }],
      ["a main push with no eligible proof", { ...main, verdict: "false", defaultOutputs: dflt("false", "false") }, { paid: 0, witness: false }],
      ["a main push with an eligible, certified proof", eligible, { paid: paid.length, witness: true }],
      ["a witness upload that failed after the verifier said true", { ...eligible, stepOutcome: { keep: "failure" } }, { paid: paid.length, witness: false }],
      ["a witness upload that timed out after the verifier said true", { ...eligible, evidenceTimeoutAt: "keep" }, { paid: paid.length, witness: false }],
      ["a retained witness that is missing or malformed after the verifier said true", { ...eligible, stepOutputs: { handover: { reuse: "false" } } },
        { paid: paid.length, witness: false }],
      ["a handover killed by the job timeout", { ...eligible, evidenceTimeoutAt: "handover" }, { paid: paid.length, witness: false }],
      ["an evidence setup step that failed (step level)", { ...eligible, stepOutcome: { [firstSetup]: "failure" } }, { paid: paid.length, witness: false }],
      ["a failed screen", { ...main, jobs: failed("screen"), defaultOutputs: dflt("false", "true") }, { paid: 0, witness: false }],
      ["a timed-out screen", { ...main, jobs: { screen: { result: "failure" } }, defaultOutputs: dflt("false", "true") }, { paid: 0, witness: false }],
      ["a skipped preflight (the screen never ran)", { ...main, jobs: { screen: { result: "skipped" } }, defaultOutputs: dflt("false", "true") }, { paid: 0, witness: false }],
      ["a failed current-certificate probe", { ...main, jobs: failed(...paid), defaultOutputs: dflt("false", "true") }, { paid: paid.length, witness: false }],
      ["an evidence job whose setup step failed", { ...main, jobs: failed("evidence"), defaultOutputs: dflt("true", "true") }, { paid: paid.length, witness: false }],
      ["an evidence job that timed out", { ...main, jobs: { evidence: { result: "failure" } }, defaultOutputs: dflt("true", "true") }, { paid: paid.length, witness: false }],
    ];
    for (const [name, scenario, want] of SCENARIOS) {
      // A skipped screen is forced by its result, not by a condition.
      for (const coe of ["failure", "success"]) {
        let g;
        try {
          const forced = structuredClone(doc);
          if (scenario.jobs?.screen?.result === "skipped" && forced.jobs.screen) forced.jobs.screen.if = "false";
          g = evalLaneGraph(forced, scenario, coe);
        } catch (err) { out.push(`${where}: ${name}: the job graph cannot be evaluated (${err.message})`); continue; }
        const tag = `${where}: ${name} (a failed continue-on-error job reported as ${coe})`;
        const ranPaid = paid.filter((j) => g.get(j).runs).length;
        if (ranPaid !== want.paid) out.push(`${tag}: ${ranPaid} paid certify job(s) started, want ${want.paid}`);
        for (const id of originals) {
          const st = g.get(id);
          if (!st.runs) { out.push(`${tag}: original job ${id} was SKIPPED, want it to run`); continue; }
          const runner = lane.jobs[id].runner;
          const expect = want.witness && lane.jobs[id].mode !== "fresh" ? "ubuntu-latest" : runner;
          if (st.runsOn !== expect) out.push(`${tag}: original job ${id} runs on ${st.runsOn}, want ${expect}`);
        }
        for (const [id, st] of g) if (st.red && !originals.includes(id)) out.push(`${tag}: auxiliary job ${id} turns the run red`);
      }
    }
  }
  return out;
}

if (evidenceRegistry) {
  {
    const real = evidenceWorld();
    real.pendingCallers = [];
    for (const message of evidenceAdoptionFailures(real)) check(false, message);
    for (const key of real.pendingCallers) {
      console.warn(`ci-event-policy-test: PENDING ${key} — ${EVIDENCE_CALLER_GRANT_PENDING[key]}`);
    }
  }
  for (const [name, mutate, expect] of EVIDENCE_MUTATIONS) {
    let got;
    try {
      const w = evidenceWorld();
      mutate(w);
      got = evidenceAdoptionFailures(w);
    } catch (err) {
      check(false, `6x mutation "${name}" threw instead of reporting: ${err.message}`);
      continue;
    }
    check(got.some((m) => expect.test(m)), `6x did NOT complain about "${name}". Expected ${expect}; got `
      + `${got.length === 0 ? "no failures at all" : JSON.stringify(got)}. A rule about what a witness may skip `
      + "that cannot fail is the most expensive kind of green.");
  }
  // The two consistent edits are a valid adoption to every GENERIC rule: the
  // explicit macOS order assertion is the only thing that refuses them.
  for (const [name, mutate] of EVIDENCE_MUTATIONS.filter(([n]) => / consistently /.test(n))) {
    const w = evidenceWorld();
    let got;
    try { mutate(w); got = evidenceAdoptionFailures(w); } catch (err) { check(false, `6x "${name}" threw instead of reporting: ${err.message}`); continue; }
    check(got.length > 0 && got.every((m) => /^macos\.yml \(evidence lane macos\)\/(ui-smoke|signed-build): needs /.test(m)),
      `6x "${name}" was refused by something other than the explicit macOS order alone: ${JSON.stringify(got)}`);
  }

  // The graph, on the real adopted workflows: every scenario, both reporting conventions.
  for (const message of evidenceGraphFailures(evidenceWorld())) check(false, message);

  // macOS's serial order, through the same evaluator over the REAL adopted
  // macos.yml (its own needs and conditions, not a mirror of them): ui-smoke
  // waits for contract and evidence only, so a red `test` no longer holds it
  // back, while a red contract and a fork still skip it and signed-build still
  // needs both. What a red `test` does to the CALLERS is not simulated here: it
  // is GitHub's rule that a failed job fails its workflow, read against the
  // callers' own conditions (merge-gate.yml judges each called lane's result;
  // macos-release.yml's notarize-stage requires `needs.build.result == 'success'`).
  {
    const mac = evidenceWorld().docs.get("macos.yml");
    const outputs = (reuse) => (id) => (id === "evidence" ? { reuse, witness: "" } : id === "screen" ? { eligible: "false" } : {});
    const noProof = { event: "push", ref: "refs/heads/main", verdict: "false", defaultOutputs: outputs("false") };
    const pr = { event: "pull_request", ref: "refs/pull/1/merge", defaultOutputs: outputs("") };
    for (const [name, scenario, want] of [
      ["a main push whose contract is red", { ...noProof, jobs: { contract: { result: "failure" } } }, { "ui-smoke": null, "signed-build": null, red: ["contract"] }],
      ["a main push whose unit suite is red", { ...noProof, jobs: { test: { result: "failure" } } }, { "ui-smoke": "macos-15", "signed-build": null, red: ["test"] }],
      ["a main push whose evidence job failed", { ...noProof, jobs: { evidence: { result: "failure" } }, defaultOutputs: outputs("true") },
        { "ui-smoke": "macos-15", "signed-build": "macos-15", red: [] }],
      ["a same-repository pull request", pr, { "ui-smoke": "macos-15", "signed-build": "macos-15", red: [] }],
      ["a fork pull request", { ...pr, headRepo: "someone/relayium" }, { "ui-smoke": null, "signed-build": null, red: [] }],
      ["a fork pull request whose unit suite is red", { ...pr, headRepo: "someone/relayium", jobs: { test: { result: "failure" } } },
        { "ui-smoke": null, "signed-build": null, red: ["test"] }],
    ]) {
      for (const coe of ["failure", "success"]) {
        let g;
        try { g = evalLaneGraph(structuredClone(mac), scenario, coe); } catch (err) { check(false, `macOS order: ${name}: ${err.message}`); continue; }
        for (const id of ["ui-smoke", "signed-build"]) {
          const st = g.get(id);
          const got = st?.runs ? st.runsOn : null;
          check(got === want[id], `macOS order: ${name} (continue-on-error failure reported as ${coe}): ${id} `
            + `${got === null ? "is skipped" : `runs on ${got}`}, want ${want[id] === null ? "skipped" : want[id]}`);
        }
        const red = [...g].filter(([, st]) => st.red).map(([id]) => id).sort();
        check(JSON.stringify(red) === JSON.stringify(want.red), `macOS order: ${name}: red jobs ${JSON.stringify(red)}, want ${JSON.stringify(want.red)}`);
      }
    }
  }
  // ...and the graph rule fails for the stated reason when the execution graph
  // is broken the ways this revision fixed: each control below must produce
  // exactly the named failure, or the graph rule is a harness that cannot fail.
  // Revision 2's graph: original jobs on implicit success() behind `needs: evidence`.
  const implicitOriginals = (w) => {
    for (const [, lane] of Object.entries(w.evidenceRegistry.lanes)) {
      const d = w.docs.get(lane.workflow);
      for (const [id, e] of Object.entries(lane.jobs)) if (e.mode !== "fresh") delete d.jobs[id].if;
    }
  };
  for (const [name, mutate, expect] of [
    ["revision 2's graph: a transient Ubuntu setup failure", (w) => { implicitOriginals(w); delete w.docs.get("go.yml").jobs.evidence["continue-on-error"]; },
      /go\.yml \(evidence lane go\): an evidence job whose setup step failed \(a failed continue-on-error job reported as failure\): original job test was SKIPPED/],
    ["revision 2's graph: an evidence-job timeout", (w) => { implicitOriginals(w); delete w.docs.get("compat.yml").jobs.evidence["continue-on-error"]; },
      /compat\.yml \(evidence lane compat\): an evidence job that timed out \(a failed continue-on-error job reported as failure\): original job wire-vectors was SKIPPED/],
    ["revision 2's graph: a skipped preflight", (w) => { implicitOriginals(w); delete w.docs.get("ios.yml").jobs.evidence.if; },
      /ios\.yml \(evidence lane ios\): a skipped preflight \(the screen never ran\) .*: original job ios-build was SKIPPED/],
    ["revision 2's graph: a failed current-certificate probe", (w) => { implicitOriginals(w); w.docs.get("swift-package.yml").jobs.evidence.if = "success()"; },
      /swift-package\.yml \(evidence lane swift-package\): a failed current-certificate probe \(a failed continue-on-error job reported as failure\): original job swift-test was SKIPPED/],
    ["revision 3's first draft: outputs promoted from the verifier before the witness upload", (w) => {
      w.docs.get("ios.yml").jobs.evidence.outputs = { reuse: "${{ steps.verify.outputs.reuse }}", witness: "${{ steps.verify.outputs.witness }}" };
    }, /ios\.yml \(evidence lane ios\): a witness upload that failed after the verifier said true .*: original job ios-ipad-shell runs on ubuntu-latest, want macos-15/],
    ["outputs promoted on a timed-out upload", (w) => {
      w.docs.get("macos.yml").jobs.evidence.outputs = { reuse: "${{ steps.verify.outputs.reuse }}", witness: "${{ steps.verify.outputs.witness }}" };
    }, /macos\.yml \(evidence lane macos\): a witness upload that timed out after the verifier said true .*: original job test runs on ubuntu-latest, want macos-15/],
    ["a handover that runs even after a failed upload", (w) => {
      w.docs.get("web.yml").jobs.evidence.steps.find((st) => st.id === "handover").if = "always() && steps.verify.outputs.reuse == 'true'";
    }, /web\.yml \(evidence lane web\): a witness upload that failed after the verifier said true .*: original job windows-temporary-downloader runs on ubuntu-latest, want windows-latest/],
    ["the evidence job can turn the run red", (w) => { delete w.docs.get("android.yml").jobs.evidence["continue-on-error"]; },
      /android\.yml \(evidence lane android\): an evidence job that timed out .*: auxiliary job evidence turns the run red/],
    ["paid probes start without an eligible screen", (w) => {
      w.docs.get("ios.yml").jobs["certify-macos"].if = `\${{ !cancelled() && ${EV_MAIN_PUSH} }}`;
    }, /ios\.yml \(evidence lane ios\): a main push with no eligible proof .*: 1 paid certify job\(s\) started, want 0/],
    ["paid probes start when the screen failed", (w) => {
      w.docs.get("go.yml").jobs["certify-windows"].if = `\${{ !cancelled() && ${EV_MAIN_PUSH} && needs.screen.outputs.eligible != 'false' }}`;
    }, /go\.yml \(evidence lane go\): a failed screen .*: 1 paid certify job\(s\) started, want 0/],
    ["a failed screen turns the run red", (w) => { delete w.docs.get("web.yml").jobs.screen["continue-on-error"]; },
      /web\.yml \(evidence lane web\): a failed screen .*: auxiliary job screen turns the run red/],
    ["the fresh signed build stays on implicit success()", (w) => {
      w.docs.get("macos.yml").jobs["signed-build"].if = "github.event_name != 'pull_request' || github.event.pull_request.head.repo.full_name == github.repository";
    }, /macos\.yml \(evidence lane macos\): an evidence job whose setup step failed \(a failed continue-on-error job reported as failure\): original job signed-build was SKIPPED/],
    ["a witnessed platform job keeps its platform runner", (w) => { w.docs.get("ios.yml").jobs["ios-ipad-shell"]["runs-on"] = "macos-15"; },
      /ios\.yml \(evidence lane ios\): a main push with an eligible, certified proof .*: original job ios-ipad-shell runs on macos-15, want ubuntu-latest/],
  ]) {
    const w = evidenceWorld();
    mutate(w);
    let got = [];
    try { got = evidenceGraphFailures(w); } catch (err) { got = [`threw: ${err.message}`]; }
    check(got.some((m) => expect.test(m)), `6x graph control "${name}" did not fail for its stated reason. Expected ${expect}; got `
      + `${got.length === 0 ? "no failures at all" : JSON.stringify(got.slice(0, 4))}`);
  }

  // The projection is fail-closed: a guard in any non-canonical shape survives
  // it, so the owning sections below still see a step that can skip itself;
  // and a lane whose evidence job is not exactly canonical is not projected.
  {
    const lane = evidenceRegistry.lanes.compat;
    const raw = evidenceRawTexts.get("compat.yml") ?? "";
    const canonical = `        if: ${EV_FULL}\n        working-directory: web\n        run: npm run test:vectors`;
    check(raw.includes(canonical), "6x's projection controls lost their anchor in compat.yml's wire-vectors step.");
    const odd = raw.replace(canonical, `        if: ${EV_FULL} || github.actor == 'x'\n        working-directory: web\n        run: npm run test:vectors`);
    // Not canonical ⇒ not projected AT ALL: the whole adoption stays visible.
    check(odd !== raw && fullPathText(odd, "compat", lane, evidenceToolchain) === odd,
      "6x's full-path projection projected a file with a NON-canonical evidence guard; the older compat rule would "
      + "then be told a gate step that can skip itself is the original.");
    const oddJob = raw.replace(`        if: ${EV_MAIN_PUSH}\n        uses: ${EV_CHECKOUT} # v6.0.2`, `        if: always()\n        uses: ${EV_CHECKOUT} # v6.0.2`);
    check(oddJob !== raw && fullPathText(oddJob, "compat", lane, evidenceToolchain) === oddJob,
    "6x's full-path projection stripped a lane whose evidence job is not canonical; with the job left in place "
      + "every older rule must keep seeing the adoption it would otherwise have been told is safe.");
    const go = parseYaml(fullPathText(evidenceRawTexts.get("go.yml") ?? "", "go", evidenceRegistry.lanes.go, evidenceToolchain));
    check(go.jobs?.["cli-windows"]?.["runs-on"] === "windows-latest"
      && go.jobs?.test?.steps?.find((st) => st.name === "Keep the CLI matrix log (on failure)")?.if === "failure()"
      && !mentionsEvidence(go.jobs) && go.jobs?.evidence === undefined && go.jobs?.["certify-windows"] === undefined
      && !JSON.stringify(go.jobs).includes("ci-evidence-toolchain"),
    "6x's full-path projection does not restore go.yml's original runners, conditions and jobs.");
  }

  // Hand the full path to every section below: exactly what runs when the
  // decision is not 'true', parsed from the inverse of the canonical adoption.
  for (const [laneId, lane] of Object.entries(evidenceRegistry.lanes)) {
    const raw = evidenceRawTexts.get(lane.workflow);
    if (raw === undefined) continue;
    try {
      const view = parseYaml(fullPathText(raw, laneId, lane, evidenceToolchain));
      // Triggers are not part of the witness/full split: GitHub evaluates the
      // REAL `on:` block, evidence inputs included, on both paths. So every
      // trigger, path-filter and fixture rule below judges the raw block.
      view.on = docs.get(lane.workflow)?.on;
      docs.set(lane.workflow, view);
    } catch (err) {
      check(false, `${lane.workflow}: its full-path projection does not parse (${err.message}).`);
    }
  }
}

/** The steps of every job, flattened, with the job name attached. */
function allSteps(doc) {
  const out = [];
  for (const [jobName, job] of Object.entries(doc?.jobs ?? {})) {
    for (const step of job?.steps ?? []) out.push({ jobName, job, step });
  }
  return out;
}

const runText = (job) => (job?.steps ?? []).map((s) => s?.run ?? "").join("\n");

// ── 1. the trigger shape of every governed workflow ────────────────────
//
// Moved into `triggerFailures(world)`, beside the other world functions, so
// section 8 can break each of its rules and require the complaint. The rules
// themselves changed with the aggregate merge gate:
//
//   * `push: branches: [main]` is unchanged and is now LOAD-BEARING beyond
//     tidiness. `merge-gate.yml` runs on `pull_request` only, so a lane's own
//     `push` trigger is the only thing that puts a check run on the `main`
//     commit — and `relayium-ops`' `deploy/promote.sh` refuses to promote a
//     `main` commit whose `wire-vectors` check run is absent. A future "make
//     everything go through the gate" cleanup that dropped a `push: main` would
//     wedge every production promotion with `required check absent`, mid
//     incident. That reasoning lives in a different repository, so the rule is
//     encoded here.
//   * `pull_request:` is FORBIDDEN on every lane the gate calls, with no
//     exception left. Keeping it on a converted lane runs that lane twice per
//     commit for nothing, once directly and once through the gate. On
//     `compat.yml` running twice WAS the whole point, for one migration step:
//     the direct run reported the bare `wire-vectors` context `main` then
//     required, and the called run was what the aggregate judged. Protection
//     edit B made `merge-gate` the sole required context, so the direct trigger
//     is gone and the ban is now uniform. Section 6o carries what compat may
//     not grow back, including the concurrency discriminator that existed only
//     to keep those two runs apart.
//   * `workflow_call:` is required on exactly the lanes the gate calls. Without
//     it the gate's `uses:` is unresolvable and the WHOLE run fails to load, so
//     `merge-gate` never reports at all and the merge box shows a missing
//     required check rather than a red one.
//
// The old `push.paths === pull_request.paths` rule went with the trigger it
// compared against. What it protected — a filter that is narrower on one event
// than the other — is now structurally impossible for a converted lane, because
// there is only one filtered event left; and what each filter must actually
// SELECT is asserted behaviourally by section 5g's matrix and, independently,
// by `scripts/test/ci-lane-selector-test.mjs`.

function triggerFailures(world) {
  const out = [];
  const need = (ok, message) => { if (!ok) out.push(message); };

  for (const { file, dispatch, call, directPr } of world.governed) {
    const doc = world.docs.get(file);
    if (!doc) continue;
    const on = doc.on;
    need(on && typeof on === "object", `${file}: no \`on:\` mapping`);
    if (!on || typeof on !== "object") continue;

    need("push" in on, `${file}: lost its \`push\` trigger. That is the ONLY event that puts a `
      + `check run on the \`main\` commit now that ${AGGREGATE} owns pull requests, and `
      + `\`relayium-ops\`' \`deploy/promote.sh\` reads check runs on \`main\` before it promotes. `
      + `A lane that loses this does not fail visibly here; it wedges production promotion with `
      + `\`required check absent\`.`);

    const push = on.push;
    const branches = push && typeof push === "object" ? push.branches : undefined;
    need(
      Array.isArray(branches) && branches.length === 1 && branches[0] === "main",
      `${file}: \`push.branches\` is ${JSON.stringify(branches)}, want exactly ["main"]. `
      + `Without it a branch push and its pull request both run this workflow against the same `
      + `tree — two identical runs per commit, both green, and nothing reports the duplicate.`,
    );

    need(
      ("workflow_call" in on) === (call === true),
      `${file}: \`workflow_call\` is ${"workflow_call" in on ? "present" : "absent"}, want `
      + `${call ? "present" : "absent"}. ${call
        ? `${AGGREGATE} calls this file, and that call is the only way a pull request reaches it. `
          + `Without the trigger the gate's \`uses:\` is unresolvable, the entire run fails to `
          + `load, and the required context never reports at all.`
        : `Nothing calls this file. A \`workflow_call:\` here is a second entry point nobody `
          + `costed, and for ${COMPAT} it is the migration step that renames the context \`main\` `
          + `currently requires.`}`,
    );

    need(
      ("pull_request" in on) === (directPr === true),
      `${file}: \`pull_request\` is ${"pull_request" in on ? "present" : "absent"}, want `
      + `${directPr ? "present" : "absent"}. ${directPr
        ? `This file has not moved into ${AGGREGATE} yet and is still its own pull-request entry `
          + `point; losing the trigger leaves branch work ungated by it.`
        : `${AGGREGATE} calls this file, so a direct trigger runs it TWICE for every commit on a `
          + `branch with an open pull request — once directly, once through the gate. That is the `
          + `duplicate this repository already removed once.`}`,
    );

    // The `push.paths === pull_request.paths` comparison that used to sit here
    // went with the last direct pull-request trigger, and deliberately rather
    // than by omission. It could only ever apply to a lane owning BOTH filtered
    // events, `compat.yml` was the last such lane, and what the rule protected
    // — a filter narrower on one event than the other — is structurally
    // impossible with one filtered event left. Keeping it would have left an
    // assertion no mutation in section 8 can reach, in a file whose whole
    // authority is that each of its rules is proven able to fail.
    // `scripts/test/contract-ci-policy-test.mjs` dropped the same comparison
    // for the same reason when its two lanes converted.

    need(
      ("workflow_dispatch" in on) === dispatch,
      `${file}: workflow_dispatch is ${"workflow_dispatch" in on ? "present" : "absent"}, `
      + `want ${dispatch ? "present" : "absent"}`,
    );

    need(
      !("schedule" in on),
      `${file}: gained a \`schedule\` trigger. Scheduled runs of a gating workflow burn runners `
      + `on a tree nobody changed; put the scheduled lane in its own workflow.`,
    );
  }

  return out;
}

// ── 2. concurrency: PR number, run_id for everything else ───────────────────
//
// Moved into `concurrencyFailures(world)`, beside the other world functions, so
// section 8 can break each of its rules and require the complaint. The rules did
// not change by moving: the same files, the same suffix, and — since the macOS
// CI/release split — a per-file PREFIX, a ban on `github.workflow` in a reusable
// callee, and uniqueness across every file governed here.

/** Every file whose concurrency block this policy binds. */
const CONCURRENCY_GOVERNED = [...files, MACOS_RELEASE, ...EXTRA_PARSED];

// ── 3. the race shards: account (FNV, eight) and renewal (weighted, two) ────
//
// Two jobs carry a `strategy.matrix.shard`, and each is proved on its own:
// its exact index list, fail-fast off, the planner invoked with its shard count
// and the matrix index (so the planner's own partition proof covers every
// index), the race command restricted to the planner's selector, and timing
// evidence that is always uploaded under a name unique to lane, shard and
// attempt. The rules live in a function so the controls below can break each
// one and require the complaint; a rule no mutation can trip is not a rule.

const go = docs.get("go.yml");
/** The shard lanes, by job id: what each must plan and how it must be checked. */
const GO_SHARD_LANES = [
  {
    job: "race-account", lane: "account", shards: SHARDS, pkg: "./account", maxPackageMinutes: 20,
    // Weighted over the accepted account profile (pinned below by digest); the
    // package and the ^Test list stay the helper's defaults, so the compiled
    // list of every top-level test remains the source of truth, and the
    // package's own reasoned skips stay allowed.
    planner: [`-weights ../${ACCOUNT_WEIGHTS}`, `-shards ${SHARDS}`, "-shard '${{ matrix.shard }}'"],
    forbidden: ["-package", "-pattern", "-require-pass", "-forbid-skip", `-weights ../${RENEW_WEIGHTS}`],
    evidence: ["-lane account"],
  },
  {
    job: RENEW_JOB, lane: "renewal", shards: 2, pkg: "./cmd/relayium", maxPackageMinutes: 20,
    planner: ["-package ./cmd/relayium", `-pattern '${RENEW_PATTERN}'`, `-weights ../${RENEW_WEIGHTS}`,
      "-shards 2", "-shard '${{ matrix.shard }}'"],
    forbidden: [],
    evidence: ["-lane renewal", "-require-pass", "-forbid-skip", "-expect-inventory \"$out/declared.txt\""],
  },
];

/** The minutes of a `-timeout` like 20m or 90s, or NaN. */
const goMinutes = (d) => {
  const m = /^(\d+)([ms])$/.exec(d ?? "");
  return m ? Number(m[1]) / (m[2] === "m" ? 1 : 60) : NaN;
};

/** Reports, through `check`, every way the Go race lanes stop covering what they claim. */
function checkGoRaceLanes(doc) {
  const jobs = doc?.jobs ?? {};
  const shardJobs = Object.entries(jobs).filter(([, job]) => job?.strategy?.matrix?.shard !== undefined);
  check(
    JSON.stringify(shardJobs.map(([n]) => n).sort()) === JSON.stringify(GO_SHARD_LANES.map((l) => l.job).sort()),
    `go.yml: the jobs with a \`strategy.matrix.shard\` are ${JSON.stringify(shardJobs.map(([n]) => n))}, want `
    + `exactly ${JSON.stringify(GO_SHARD_LANES.map((l) => l.job))}. Those matrices are what split the account race `
    + `lane and the renewal tests into finite pieces.`,
  );
  const uploadNames = [];
  for (const lane of GO_SHARD_LANES) {
    const job = jobs[lane.job];
    const name = lane.job;
    if (job === undefined) {
      check(false, `go.yml: the \`${name}\` shard job is gone; its tests would run nowhere.`);
      continue;
    }
    const shard = job.strategy?.matrix?.shard;
    check(
      Array.isArray(shard) && shard.map(String).join(",") === Array.from({ length: lane.shards }, (_, k) => k).join(","),
      `go.yml/${name}: matrix.shard is ${JSON.stringify(shard)}, want 0..${lane.shards - 1}. `
      + `A missing index is a set of tests that silently stops being race-checked.`,
    );
    check(
      job.strategy?.["fail-fast"] === "false",
      `go.yml/${name}: strategy.fail-fast is ${JSON.stringify(job.strategy?.["fail-fast"])}, want false — `
      + `one shard failing must not cancel the others and leave them unknown.`,
    );
    // Continuation lines joined, so a flag is found wherever the line breaks.
    const text = runText(job).replace(/\\\n\s*/g, " ");
    const plannerLine = (text.split(`go run ../${SHARD_HELPER}`)[1] ?? "").split(")\"")[0];
    check(
      text.includes(`go run ../${SHARD_HELPER}`),
      `go.yml/${name}: no longer invokes ${SHARD_HELPER}, which is what proves the shards partition `
      + `the test list exactly.`,
    );
    for (const flag of [...lane.planner, "-plan-out \"$out/plan.json\""]) {
      check(plannerLine.includes(flag), `go.yml/${name}: the ${SHARD_HELPER} call lacks \`${flag}\`; `
        + `without it the shards do not plan the ${lane.lane} lane's list, or do not record the plan.`);
    }
    for (const flag of lane.forbidden) {
      check(!text.includes(flag), `go.yml/${name}: uses \`${flag}\`. The ${lane.lane} lane stays FNV until `
        + `a real eight-shard timing corpus is accepted, and its skips are the package's own.`);
    }
    const goLine = text.split("\n").find((l) => /^\s*go test -race /.test(l)) ?? "";
    check(
      /-run "\$RUN_REGEX"/.test(goLine) && goLine.includes(` ${lane.pkg} `) && /(^|\s)-json(\s|$)/.test(goLine),
      `go.yml/${name}: does not run \`go test -race ... -json -run "$RUN_REGEX" ${lane.pkg}\`.`,
    );
    const timeout = /-timeout\s+(\S+)/.exec(goLine)?.[1];
    check(
      goMinutes(timeout) > 0 && goMinutes(timeout) <= lane.maxPackageMinutes
        && Number(job["timeout-minutes"]) > goMinutes(timeout) && Number(job["timeout-minutes"]) <= 25,
      `go.yml/${name}: -timeout ${timeout} under timeout-minutes ${job["timeout-minutes"]}; want a package `
      + `bound in (0, ${lane.maxPackageMinutes}m] inside a job bound of at most 25. Exceeding either is a hang.`,
    );
    check(
      /set -euo pipefail/.test(text)
        && goLine.includes(`| tee "$out/go-test.json" | go run ../${TIMINGS_TOOL} render || status=$?`)
        && /\bexit "\$status"/.test(text),
      `go.yml/${name}: go test's status no longer survives the pipe: want \`set -euo pipefail\`, the stream `
      + `teed to "$out/go-test.json" through \`${TIMINGS_TOOL} render || status=$?\`, and \`exit "$status"\`.`,
    );
    const evidenceText = (text.split(`go run ../${TIMINGS_TOOL} evidence`)[1] ?? "").split(/\n\s*exit "\$status"/)[0];
    for (const flag of [...lane.evidence, "-plan \"$out/plan.json\"", "-json \"$out/go-test.json\"",
      "-source-sha \"$(git rev-parse HEAD)\"", "-toolchain \"$(go version)\"", "-run-id \"$GITHUB_RUN_ID\"",
      "-run-attempt \"$GITHUB_RUN_ATTEMPT\"", "-race -count 1",
      "-go-exit \"$status\"", "-out \"$out/evidence.json\"", "|| { [ \"$status\" -ne 0 ] || status=1; }"]) {
      check(evidenceText.includes(flag), `go.yml/${name}: the ${TIMINGS_TOOL} evidence call lacks \`${flag}\`; `
        + `the timing evidence would not bind the run it describes, or its failure would not fail the step.`);
    }
    const upload = (job.steps ?? []).find((s) => /actions\/upload-artifact@/.test(s?.uses ?? ""));
    const artifact = upload?.with?.name ?? "";
    uploadNames.push(artifact.replace(/\$\{\{[^}]*\}\}/g, "*"));
    check(
      upload !== undefined && upload.if === "always()"
        && artifact.includes(lane.lane) && artifact.includes("${{ matrix.shard }}")
        && artifact.includes("${{ github.run_attempt }}")
        && upload.with?.path === "${{ runner.temp }}/go-race-timing"
        && upload.with?.["if-no-files-found"] === "error",
      `go.yml/${name}: the timing evidence must be uploaded \`if: always()\` from `
      + `\${{ runner.temp }}/go-race-timing with if-no-files-found: error, under a name carrying the lane, `
      + `\${{ matrix.shard }} and \${{ github.run_attempt }}; got ${JSON.stringify(upload ?? null)}.`,
    );
    assertNoRetryAndFiniteTimeouts("go.yml", name, job, text);
  }
  check(
    new Set(uploadNames).size === uploadNames.length,
    `go.yml: two shard lanes upload timing evidence under the same artifact name pattern `
    + `${JSON.stringify(uploadNames)}; one would overwrite or reject the other.`,
  );

  // The other half of ./... — everything the shards do not cover.
  const restJobs = Object.entries(jobs).filter(([jobName, job]) => {
    const text = runText(job);
    return !GO_SHARD_LANES.some((l) => l.job === jobName) && /go test .*-race/.test(text);
  });
  check(
    restJobs.length === 1,
    `go.yml: expected exactly one non-shard race job; found ${restJobs.length}. Without it every `
    + `package outside server/account stops being race-checked, and the board stays green.`,
  );
  if (restJobs.length === 1) {
    const [name, job] = restJobs[0];
    const text = runText(job);
    check(
      text.includes("go list ./..."),
      `go.yml/${name}: does not enumerate packages with \`go list ./...\`, so a newly added package `
      + `would not be race-checked until someone remembered to add it.`,
    );
    check(
      text.includes(`grep -v '^${ACCOUNT_PKG}$'`),
      `go.yml/${name}: does not exclude exactly \`${ACCOUNT_PKG}\`. An unanchored or broader `
      + `exclusion would also drop a future account/... subpackage from every race lane.`,
    );
    assertNoRetryAndFiniteTimeouts("go.yml", name, job, text);
  }

  // 3b. The A11 renewal driver tests: skipped by `test` and `race-rest`,
  // planned by `link-renew` — with ONE pattern, so the skip is exactly the
  // complement of the two renewal shards. The planner lists the package with
  // that pattern and proves its two selectors partition the list, so the
  // union is the skipped set by construction, new tests included.
  const skipFlag = `-skip '${RENEW_PATTERN}'`;
  for (const [jobName, job] of Object.entries(jobs)) {
    const text = runText(job);
    // `-skip` as its own word: `-forbid-skip` is the evidence tool's flag.
    const skips = [...text.matchAll(/(?<=^|\s)-skip\s+('[^']*'|"[^"]*"|\S+)/g)].map((m) => m[1]);
    for (const sk of skips) {
      check(sk === `'${RENEW_PATTERN}'`,
        `go.yml/${jobName}: \`-skip ${sk}\` is not the renewal pattern '${RENEW_PATTERN}'. A skip no job `
        + `makes up for deletes coverage silently.`);
    }
    if (jobName === "test" || jobName === "race-rest") {
      check(text.includes(skipFlag) && skips.length === 1,
        `go.yml/${jobName}: expected exactly one \`${skipFlag}\` (the renewal tests run in \`${RENEW_JOB}\`); `
        + `found ${JSON.stringify(skips)}. Without it cmd/relayium outruns the per-package bound.`);
    }
    if (jobName !== "test" && jobName !== "race-rest" && jobName !== RENEW_JOB) {
      check(!text.includes(RENEW_PATTERN),
        `go.yml/${jobName}: names the renewal pattern; only \`test\`, \`race-rest\` (skip) and `
        + `\`${RENEW_JOB}\` (plan) may.`);
    }
  }
}

/** Runs `fn` and returns, instead of keeping, the failures it reported. */
function captureFailures(fn) {
  const start = failures.length;
  fn();
  return failures.splice(start);
}

if (go) {
  checkGoRaceLanes(go);

  // The controls: each mutation must be reported, with its reason. Starting
  // from the real go.yml, so a control that stays green means the rule above
  // has stopped reading what go.yml actually says.
  const clone = () => structuredClone(go);
  const stepWith = (doc, job, needle) => doc.jobs[job].steps.find((s) => (s.run ?? "").includes(needle));
  const editRun = (job, from, to) => (doc) => {
    const step = stepWith(doc, job, from);
    if (step) step.run = step.run.replace(from, to);
  };
  const upload = (job) => (doc) => doc.jobs[job].steps.find((s) => /upload-artifact/.test(s.uses ?? ""));
  const GO_LANE_CONTROLS = [
    { name: "an account matrix index is dropped", expect: /race-account: matrix\.shard is .*want 0\.\.7/,
      mutate: (d) => { d.jobs["race-account"].strategy.matrix.shard = ["0", "1", "2", "3", "4", "5", "7"]; } },
    { name: "a renewal matrix index is dropped", expect: /link-renew: matrix\.shard is .*want 0\.\.1/,
      mutate: (d) => { d.jobs[RENEW_JOB].strategy.matrix.shard = ["0"]; } },
    { name: "the renewal matrix is removed", expect: /strategy\.matrix\.shard` are .*want exactly/,
      mutate: (d) => { delete d.jobs[RENEW_JOB].strategy; } },
    { name: "renewal fail-fast", expect: /link-renew: strategy\.fail-fast/,
      mutate: (d) => { d.jobs[RENEW_JOB].strategy["fail-fast"] = "true"; } },
    { name: "the renewal planner forgets the pattern", expect: /link-renew: the scripts\/go-race-shard\.go call lacks `-pattern/,
      mutate: editRun(RENEW_JOB, `-pattern '${RENEW_PATTERN}'`, "-pattern '^TestLinkRenew'") },
    { name: "the renewal planner drops the measured weights", expect: /link-renew: the scripts\/go-race-shard\.go call lacks `-weights/,
      mutate: editRun(RENEW_JOB, `-weights ../${RENEW_WEIGHTS} `, "") },
    { name: "the account lane drops its measured profile (back to FNV)",
      expect: /race-account: the scripts\/go-race-shard\.go call lacks `-weights \.\.\/scripts\/go-race-timings-account\.json`/,
      mutate: editRun("race-account", `-weights ../${ACCOUNT_WEIGHTS} `, "") },
    { name: "the account lane plans with the renewal profile", expect: /race-account: uses `-weights \.\.\/scripts\/go-race-timings-renewal\.json`/,
      mutate: editRun("race-account", `-weights ../${ACCOUNT_WEIGHTS} `, `-weights ../${RENEW_WEIGHTS} `) },
    { name: "the account lane narrows its listed tests", expect: /race-account: uses `-pattern`/,
      mutate: editRun("race-account", "-shards 8 ", "-pattern '^TestA' -shards 8 ") },
    { name: "the renewal shard count drifts", expect: /link-renew: the scripts\/go-race-shard\.go call lacks `-shards 2`/,
      mutate: editRun(RENEW_JOB, "-shards 2 ", "-shards 3 ") },
    { name: "a renewal shard may SKIP", expect: /link-renew: the scripts\/go-race-timings\.go evidence call lacks `-forbid-skip`/,
      mutate: editRun(RENEW_JOB, " -forbid-skip", "") },
    { name: "the renewal inventory is no longer checked against the declarations",
      expect: /link-renew: the scripts\/go-race-timings\.go evidence call lacks `-expect-inventory/,
      mutate: editRun(RENEW_JOB, '-expect-inventory "$out/declared.txt" ', "") },
    { name: "a renewal shard need not PASS", expect: /link-renew: the scripts\/go-race-timings\.go evidence call lacks `-require-pass`/,
      mutate: editRun(RENEW_JOB, "-require-pass ", "") },
    { name: "the evidence no longer binds the source commit", expect: /race-account: the scripts\/go-race-timings\.go evidence call lacks `-source-sha/,
      mutate: editRun("race-account", "-source-sha \"$(git rev-parse HEAD)\"", "-source-sha unknown") },
    { name: "the evidence no longer binds the GitHub run", expect: /link-renew: the scripts\/go-race-timings\.go evidence call lacks `-run-id/,
      mutate: editRun(RENEW_JOB, '-run-id "$GITHUB_RUN_ID"', "-run-id 1") },
    { name: "the evidence no longer binds the run attempt", expect: /race-account: the scripts\/go-race-timings\.go evidence call lacks `-run-attempt/,
      mutate: editRun("race-account", '-run-attempt "$GITHUB_RUN_ATTEMPT"', "-run-attempt 1") },
    { name: "an evidence failure no longer fails the step", expect: /race-account: the .* evidence call lacks `\|\| \{/,
      mutate: editRun("race-account", "|| { [ \"$status\" -ne 0 ] || status=1; }", "|| true") },
    { name: "go test's status is lost in the pipe", expect: /link-renew: go test's status no longer survives the pipe/,
      mutate: editRun(RENEW_JOB, " || status=$?", "") },
    { name: "pipefail is dropped", expect: /race-account: go test's status no longer survives the pipe/,
      mutate: editRun("race-account", "set -euo pipefail", "set -eu") },
    { name: "the renewal package bound grows past 20m", expect: /link-renew: -timeout 35m/,
      mutate: editRun(RENEW_JOB, "-timeout 20m", "-timeout 35m") },
    { name: "the renewal job bound grows past 25", expect: /link-renew: -timeout 20m under timeout-minutes 45/,
      mutate: (d) => { d.jobs[RENEW_JOB]["timeout-minutes"] = "45"; } },
    { name: "the race run drops -json", expect: /link-renew: does not run `go test -race \.\.\. -json/,
      mutate: editRun(RENEW_JOB, " -json ", " -v ") },
    { name: "the evidence upload only runs on success", expect: /race-account: the timing evidence must be uploaded `if: always\(\)`/,
      mutate: (d) => { delete upload("race-account")(d).if; } },
    { name: "the artifact name loses the shard", expect: /link-renew: the timing evidence must be uploaded/,
      mutate: (d) => { const u = upload(RENEW_JOB)(d); u.with.name = u.with.name.replace("${{ matrix.shard }}", "x"); } },
    { name: "two lanes share an artifact name", expect: /two shard lanes upload timing evidence under the same artifact name/,
      mutate: (d) => {
        const a = upload("race-account")(d); const r = upload(RENEW_JOB)(d);
        a.with.name = "go-race-timing-account-renewal-shard-${{ matrix.shard }}-attempt-${{ github.run_attempt }}";
        r.with.name = a.with.name;
      } },
    { name: "the ordinary lane skips a narrower set", expect: /go\.yml\/test: `-skip '\^\(TestLinkRenew\)'` is not the renewal pattern/,
      mutate: editRun("test", `-skip '${RENEW_PATTERN}'`, "-skip '^(TestLinkRenew)'") },
    { name: "a retry is added to a renewal shard", expect: /link-renew: a retry appeared/,
      mutate: editRun(RENEW_JOB, "status=0", "status=0 # retry once") },
  ];
  for (const c of GO_LANE_CONTROLS) {
    const doc = clone();
    c.mutate(doc);
    const got = captureFailures(() => checkGoRaceLanes(doc));
    check(got.some((m) => c.expect.test(m)),
      `section 3 control "${c.name}": checkGoRaceLanes did not report ${c.expect}; it reported `
      + `${JSON.stringify(got)}.`);
  }
  const clean = captureFailures(() => checkGoRaceLanes(clone()));
  check(clean.length === 0, `section 3: an unmutated clone of go.yml reports ${JSON.stringify(clean)}; the controls `
    + `above prove nothing if the baseline already fails.`);

  // The pattern names real tests, all of them in cmd/relayium.
  const renewSrc = spawnSync("git", ["-C", repoRoot, "grep", "-hoE", `^func ${RENEW_PATTERN.slice(1)}[A-Za-z0-9_]*`,
    "--", "server/*_test.go"], { encoding: "utf8" }).stdout ?? "";
  const renewTests = renewSrc.split("\n").filter(Boolean);
  check(renewTests.length >= 10,
    `the renewal pattern ${RENEW_PATTERN} names ${renewTests.length} test(s) in server/; want the A11 driver `
    + `tests (15 when this check was written). A rename would make \`${RENEW_JOB}\` run nothing.`);
  const outside = spawnSync("git", ["-C", repoRoot, "grep", "-lE", `^func ${RENEW_PATTERN.slice(1)}`,
    "--", "server/*_test.go"], { encoding: "utf8" }).stdout.split("\n").filter(Boolean)
    .filter((f) => !f.startsWith("server/cmd/relayium/"));
  check(outside.length === 0,
    `the renewal pattern also matches tests outside cmd/relayium (${outside.join(", ")}); \`test\` and `
    + `\`race-rest\` skip them everywhere but \`${RENEW_JOB}\` runs only ./cmd/relayium.`);

  // The account profile is exactly the accepted one: its bytes by digest and
  // its provenance field by field, with every entry a finite measured weight.
  // The digest makes a refreshed corpus a reviewed edit of this file.
  const accountFailures = (raw) => {
    const out = [];
    const digest = createHash("sha256").update(raw).digest("hex");
    if (digest !== ACCOUNT_WEIGHTS_SHA256) {
      out.push(`${ACCOUNT_WEIGHTS}: sha256 ${digest}, want the accepted ${ACCOUNT_WEIGHTS_SHA256}. A new profile needs a `
        + `new accepted corpus and a deliberate edit of ACCOUNT_WEIGHTS_SHA256.`);
    }
    let doc;
    try {
      doc = JSON.parse(raw);
    } catch (err) {
      return [...out, `${ACCOUNT_WEIGHTS} is not JSON (${err.message}); the account planner refuses to run without it.`];
    }
    if (doc.schema !== "relayium.go-test-weights/1" || doc.package !== "./account" || doc.pattern !== "^Test"
      || doc.unit !== "seconds") {
      out.push(`${ACCOUNT_WEIGHTS}: want schema relayium.go-test-weights/1, package ./account, pattern ^Test, seconds.`);
    }
    for (const [key, want] of Object.entries(ACCOUNT_WEIGHTS_PROVENANCE)) {
      if (doc.provenance?.[key] !== want) {
        out.push(`${ACCOUNT_WEIGHTS}: provenance.${key} is ${JSON.stringify(doc.provenance?.[key])}, want ${JSON.stringify(want)}.`);
      }
    }
    const tests = Array.isArray(doc.tests) ? doc.tests : [];
    const names = new Set(tests.map((t) => t?.name));
    if (tests.length < 1000 || names.size !== tests.length
      || !tests.every((t) => /^Test[A-Za-z0-9_]*$/.test(t?.name ?? "") && Number.isFinite(t?.seconds)
        && t.seconds >= 0 && t.seconds <= 21600)) {
      out.push(`${ACCOUNT_WEIGHTS}: want at least 1000 unique test names, each with a finite weight in [0, 21600] s; `
        + `got ${tests.length} entries, ${names.size} unique.`);
    }
    return out;
  };
  let accountRaw = "";
  try {
    accountRaw = readFileSync(resolve(repoRoot, ACCOUNT_WEIGHTS), "utf8");
  } catch (err) {
    check(false, `${ACCOUNT_WEIGHTS} is missing (${err.message}); the account planner refuses to run without it.`);
  }
  if (accountRaw !== "") {
    for (const m of accountFailures(accountRaw)) check(false, m);
    // Controls: each change to the profile is reported, for its own reason.
    const ACCOUNT_PROFILE_CONTROLS = [
      { name: "one weight edited", expect: /sha256 .* want the accepted/,
        raw: accountRaw.replace(/"seconds": 124\.26/, '"seconds": 1.26') },
      { name: "a different run", expect: /provenance\.runID is 1, want 36893745143/,
        raw: accountRaw.replace('"runID": 36893745143', '"runID": 1') },
      { name: "another attempt", expect: /provenance\.runAttempt is 2/, raw: accountRaw.replace('"runAttempt": 1', '"runAttempt": 2') },
      { name: "another commit", expect: /provenance\.sourceSHA/, raw: accountRaw.replace("7c47921b94b9120d528badc138d34fa0c8a6f1e9", "0".repeat(40)) },
      { name: "measured without -race", expect: /provenance\.race is false/, raw: accountRaw.replace('"race": true', '"race": false') },
      { name: "the renewal profile in its place", expect: /package \.\/account, pattern \^Test/,
        raw: readFileSync(resolve(repoRoot, RENEW_WEIGHTS), "utf8") },
      { name: "a truncated test list", expect: /want at least 1000 unique test names/,
        raw: JSON.stringify({ ...JSON.parse(accountRaw), tests: JSON.parse(accountRaw).tests.slice(0, 10) }) },
      { name: "a negative weight", expect: /finite weight in \[0, 21600\]/,
        raw: JSON.stringify({ ...JSON.parse(accountRaw),
          tests: JSON.parse(accountRaw).tests.map((t, i) => (i === 0 ? { ...t, seconds: -1 } : t)) }) },
    ];
    for (const c of ACCOUNT_PROFILE_CONTROLS) {
      const got = accountFailures(c.raw);
      check(c.raw !== accountRaw && got.some((m) => c.expect.test(m)),
        `account profile control "${c.name}": did not report ${c.expect}; reported ${JSON.stringify(got)}.`);
    }
  }

  // The measured weights describe this lane: same package and pattern, and
  // provenance a reader can trace to a real hosted run.
  let weights;
  try {
    weights = JSON.parse(readFileSync(resolve(repoRoot, RENEW_WEIGHTS), "utf8"));
  } catch (err) {
    check(false, `${RENEW_WEIGHTS} is missing or not JSON (${err.message}); the renewal planner refuses to run without it.`);
  }
  if (weights) {
    check(weights.package === "./cmd/relayium" && weights.pattern === RENEW_PATTERN
      && weights.provenance?.race === true && weights.provenance?.count === 1 && weights.provenance?.complete === true
      && /^[0-9a-f]{40}$/.test(weights.provenance?.sourceSHA ?? "") && /run \d+ job \d+/.test(weights.provenance?.source ?? ""),
      `${RENEW_WEIGHTS}: want package ./cmd/relayium, pattern ${RENEW_PATTERN}, and provenance naming a complete `
      + `-race -count=1 hosted run (run and job ids, 40-hex source SHA).`);
  }
}

// ── 3c. scripts/test/go-local.sh: the local runner README and CONTRIBUTING
//        recommend runs the SAME two halves as `test` and `link-renew` ───────
//
// Plain `go test ./...` runs the renewal tests inside Go's 10-minute package
// default and fails without a failed assertion. The runner is read here, not
// trusted: it is copied into a throw-away tree with a fake `go` first on PATH
// and run from an unrelated directory, and the arguments the fake recorded are
// compared token for token with go.yml. The fake also drives every way the
// runner must fail. bash, git and a POSIX userland are all this needs.
const LOCAL_RUNNER = "scripts/test/go-local.sh";
const ORDINARY_TIMEOUT_FLAGS = ["-count=1", "-timeout", "10m"];

/** The `go test` invocation in a job's run text that names `flag`, as argv after `go`. */
function goTestArgv(text, flag) {
  const line = text.split("\n").find((l) => /^\s*go test /.test(l) && l.includes(`${flag} '${RENEW_PATTERN}'`));
  if (line === undefined) return undefined;
  // Shell words up to the first unquoted `|` (the pattern itself contains one, quoted).
  const argv = [];
  for (const m of line.trim().matchAll(/'([^']*)'|(\S+)/g)) {
    if (m[2] === "|") break;
    argv.push(m[1] ?? m[2]);
  }
  return argv.slice(1);
}

/**
 * The renewal shards' race command as argv after `go`, and the package and
 * pattern their planner lists. Continuation lines are joined first.
 */
function ciRenewalPlan(job) {
  const text = runText(job).replace(/\\\n\s*/g, " ");
  const line = text.split("\n").find((l) => /^\s*go test -race /.test(l) && l.includes('-run "$RUN_REGEX"'));
  if (line === undefined) return undefined;
  const argv = [];
  for (const m of line.trim().matchAll(/'([^']*)'|(\S+)/g)) {
    if (m[2] === "|") break;
    argv.push(m[1] ?? m[2]);
  }
  const planner = (text.split(`go run ../${SHARD_HELPER}`)[1] ?? "").split(")\"")[0];
  return {
    argv: argv.slice(1),
    pattern: /-pattern '([^']*)'/.exec(planner)?.[1],
    pkg: /-package (\S+)/.exec(planner)?.[1],
  };
}

/** argv without one `-timeout X`, one `-run P` and the verbose flag, and what was removed. */
function splitRenewalArgv(argv, verbose) {
  const rest = [];
  const out = { timeouts: [], runs: [], verbose: 0 };
  for (let i = 0; i < (argv ?? []).length; i++) {
    if (argv[i] === "-timeout") out.timeouts.push(argv[++i]);
    else if (argv[i] === "-run") out.runs.push(argv[++i]);
    else if (argv[i] === verbose) out.verbose++;
    else rest.push(argv[i]);
  }
  return { ...out, rest };
}

/**
 * Parity between the runner's recorded argv and go.yml's.
 *
 * Ordinary must equal `test` plus only the explicit `-count=1 -timeout 10m`
 * (Go's default bound, which `test` gets implicitly).
 *
 * Renewal is compared as a COMPLETE PARTITION, not as one command literal:
 * the runner runs the whole pattern in one process; CI runs it as shards whose
 * `-run "$RUN_REGEX"` comes from the planner listing the same package with the
 * same pattern (and the planner proves its selectors' union is that list).
 * Every other argument must match token for token, with `-v` locally standing
 * for `-json` in CI (which implies -v), and the local bound at least the CI
 * per-shard bound, because the local run carries every shard's tests.
 */
function localRunnerParityFailures(ordinary, renewal, ciTest, ciRenew) {
  const out = [];
  if (ciTest === undefined || ciRenew === undefined) {
    return [`go.yml: could not find the \`test\` -skip or \`${RENEW_JOB}\` -run command to compare ${LOCAL_RUNNER} with.`];
  }
  const local = splitRenewalArgv(renewal, "-v");
  const ci = splitRenewalArgv(ciRenew.argv, "-json");
  const pkg = ci.rest.at(-1);
  const sameRest = JSON.stringify(local.rest) === JSON.stringify(ci.rest);
  const bounds = local.timeouts.length === 1 && ci.timeouts.length === 1
    && goMinutes(local.timeouts[0]) >= goMinutes(ci.timeouts[0]) && goMinutes(ci.timeouts[0]) > 0;
  if (!sameRest || local.verbose !== 1 || ci.verbose !== 1 || !bounds
    || JSON.stringify(local.runs) !== JSON.stringify([RENEW_PATTERN])
    || JSON.stringify(ci.runs) !== JSON.stringify(['"$RUN_REGEX"'])
    || ciRenew.pattern !== RENEW_PATTERN || ciRenew.pkg !== pkg) {
    out.push(`${LOCAL_RUNNER} renewal runs \`go ${renewal?.join(" ")}\`; go.yml/${RENEW_JOB} runs `
      + `\`go ${ciRenew.argv.join(" ")}\` over the planner's -package ${ciRenew.pkg} -pattern '${ciRenew.pattern}'. `
      + `The local lane must be the union of the CI shards: the same arguments, -v for -json, -run '${RENEW_PATTERN}' `
      + `for the planned selector of that same package and pattern, and a -timeout no shorter than one shard's.`);
  }
  const extra = [];
  const rest = [...(ordinary ?? [])];
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === "-count=1") { extra.push(...rest.splice(i, 1)); i--; }
    else if (rest[i] === "-timeout") { extra.push(...rest.splice(i, 2)); i--; }
  }
  if (JSON.stringify(rest) !== JSON.stringify(ciTest)
    || JSON.stringify([...extra].sort()) !== JSON.stringify([...ORDINARY_TIMEOUT_FLAGS].sort())) {
    out.push(`${LOCAL_RUNNER} ordinary runs \`go ${ordinary?.join(" ")}\`; want go.yml/test's `
      + `\`go ${ciTest.join(" ")}\` plus exactly \`${ORDINARY_TIMEOUT_FLAGS.join(" ")}\`. A selector that differs `
      + `from CI either runs the renewal tests into the 10m bound or drops tests nobody runs.`);
  }
  return out;
}

if (go) {
  const ciTest = goTestArgv(runText(go.jobs?.test), "-skip");
  const ciRenew = ciRenewalPlan(go.jobs?.[RENEW_JOB]);
  const runnerSrc = readFileSync(resolve(repoRoot, LOCAL_RUNNER), "utf8");
  const sandbox = spawnSync("mktemp", ["-d", `${process.env.TMPDIR ?? "/tmp"}/go-local-policy.XXXXXX`], { encoding: "utf8" })
    .stdout.trim();
  check(sandbox !== "", `could not create a temporary directory for the ${LOCAL_RUNNER} controls.`);
  const sh = (script, env = {}) => spawnSync("bash", ["-c", script], {
    encoding: "utf8", env: { ...process.env, ...env },
  });
  const FAKE_GO = [
    "#!/usr/bin/env bash",
    // One line per call: physical cwd, then each argument after a TAB.
    "{ printf '%s' \"$(pwd -P)\"; printf '\\t%s' \"$@\"; printf '\\n'; } >> \"$FAKE_GO_CALLS\"",
    "case \" $* \" in",
    "  *' -run '*) [ -f \"$FAKE_RENEW_OUT\" ] && cat \"$FAKE_RENEW_OUT\"; exit \"${FAKE_RENEW_RC:-0}\" ;;",
    "  *) echo 'ok  fake/ordinary'; exit \"${FAKE_ORD_RC:-0}\" ;;",
    "esac",
  ].join("\n");
  let n = 0;
  /**
   * One control: a fresh tree <root>/scripts/test/go-local.sh + <root>/server,
   * the given cmd/relayium test sources, the fake go, run from <root>/elsewhere.
   */
  const control = ({ mode = "", tests, renewOut = "", ordRc = 0, renewRc = 0, logDir }) => {
    const root = `${sandbox}/c${n++}`;
    const q = (s) => `'${s.replace(/'/g, "'\\''")}'`;
    const setup = [
      `mkdir -p ${q(root)}/scripts/test ${q(root)}/server/cmd/relayium ${q(root)}/bin ${q(root)}/elsewhere ${q(root)}/logs`,
      `printf '%s' ${q(runnerSrc)} > ${q(root)}/scripts/test/go-local.sh`,
      `printf '%s\\n' ${q(FAKE_GO)} > ${q(root)}/bin/go && chmod +x ${q(root)}/bin/go`,
      `printf '%s' ${q(tests)} > ${q(root)}/server/cmd/relayium/renew_test.go`,
      `printf '%s' ${q(renewOut)} > ${q(root)}/renew.out`,
      `: > ${q(root)}/calls`,
    ].join(" && ");
    const made = sh(setup);
    check(made.status === 0, `${LOCAL_RUNNER} control setup failed: ${made.stderr}`);
    const r = sh(`cd ${q(root)}/elsewhere && bash ../scripts/test/go-local.sh ${mode}`, {
      PATH: `${root}/bin:${process.env.PATH}`, FAKE_GO_CALLS: `${root}/calls`, FAKE_RENEW_OUT: `${root}/renew.out`,
      FAKE_ORD_RC: String(ordRc), FAKE_RENEW_RC: String(renewRc), GO_LOCAL_LOG_DIR: logDir ?? `${root}/logs`,
    });
    const serverDir = sh(`cd ${q(root)}/server && pwd -P`).stdout.trim();
    const calls = readFileSync(`${root}/calls`, "utf8").split("\n").filter(Boolean).map((l) => {
      const [cwd, ...argv] = l.split("\t");
      return { cwd, argv };
    });
    return { status: r.status, out: `${r.stdout}${r.stderr}`, calls, serverDir, root };
  };
  const TESTS = "package main\n\nfunc TestLinkRenewOne(t *testing.T) {}\nfunc TestLDRenewTwo(t *testing.T) {}\n"
    + "func helperTestLinkRenew() {}\nfunc TestUnrelated(t *testing.T) {}\n";
  const ALL_PASS = "=== RUN   TestLinkRenewOne\n--- PASS: TestLinkRenewOne (0.01s)\n"
    + "=== RUN   TestLDRenewTwo\n--- PASS: TestLDRenewTwo (0.01s)\nPASS\nok  \tfake/cmd/relayium\t0.02s\n";
  const tag = `${LOCAL_RUNNER} control`;

  // Complete expected PASS: both lanes, in order, from server/, with CI's selectors.
  const ok = control({ tests: TESTS, renewOut: ALL_PASS });
  check(ok.status === 0, `${tag} (all PASS): exit ${ok.status}, want 0.\n${ok.out}`);
  check(ok.calls.length === 2 && ok.calls.every((c) => c.cwd === ok.serverDir),
    `${tag} (all PASS): want exactly two go calls, both in ${ok.serverDir}; got ${JSON.stringify(ok.calls)}.`);
  check(/\[renewal\] PASS \(2 top-level tests/.test(ok.out),
    `${tag} (all PASS): the summary does not report exactly the 2 top-level tests the pattern names `
    + `(neither TestUnrelated nor a non-leading match counts).\n${ok.out}`);
  for (const message of localRunnerParityFailures(ok.calls[0]?.argv, ok.calls[1]?.argv, ciTest, ciRenew)) {
    check(false, message);
  }
  // The parity check can fail: a drifted pattern, a dropped -race, a missing ordinary timeout.
  const drifted = (argv, from, to) => argv?.map((a) => (a === from ? to : a));
  check(localRunnerParityFailures(drifted(ok.calls[0]?.argv, `${RENEW_PATTERN}`, "^TestLinkRenew"),
    ok.calls[1]?.argv, ciTest, ciRenew).length === 1, `3c parity did NOT notice a narrowed ordinary -skip.`);
  check(localRunnerParityFailures(ok.calls[0]?.argv, ok.calls[1]?.argv?.filter((a) => a !== "-race"),
    ciTest, ciRenew).length === 1, `3c parity did NOT notice a renewal lane without -race.`);
  check(localRunnerParityFailures(ok.calls[0]?.argv?.filter((a) => a !== "10m" && a !== "-timeout"),
    ok.calls[1]?.argv, ciTest, ciRenew).length === 1, `3c parity did NOT notice an ordinary lane without -timeout.`);
  check(localRunnerParityFailures(ok.calls[0]?.argv, drifted(ok.calls[1]?.argv, RENEW_PATTERN, "^TestLinkRenew"),
    ciTest, ciRenew).length === 1, `3c parity did NOT notice a local renewal lane narrower than the CI shards' union.`);
  check(localRunnerParityFailures(ok.calls[0]?.argv, ok.calls[1]?.argv, ciTest,
    ciRenew && { ...ciRenew, pattern: "^TestLinkRenew" }).length === 1,
  `3c parity did NOT notice CI shards planning a narrower pattern than the local renewal lane.`);
  check(localRunnerParityFailures(ok.calls[0]?.argv, drifted(ok.calls[1]?.argv, "35m", "10m"),
    ciTest, ciRenew).length === 1, `3c parity did NOT notice a local renewal bound shorter than one CI shard's.`);
  check(localRunnerParityFailures(ok.calls[0]?.argv, ok.calls[1]?.argv, ciTest,
    ciRenew && { ...ciRenew, argv: ciRenew.argv.filter((a) => a !== "-json") }).length === 1,
  `3c parity did NOT notice CI shards without -json (the evidence stream and the -v the local lane mirrors).`);
  check(localRunnerParityFailures(ok.calls[0]?.argv, ok.calls[1]?.argv, ciTest,
    ciRenew && { ...ciRenew, pkg: "./account" }).length === 1,
  `3c parity did NOT notice CI shards planning a different package from the one they run.`);

  // Mode selection runs one lane only.
  const ordOnly = control({ mode: "ordinary", tests: "" });
  check(ordOnly.status === 0 && ordOnly.calls.length === 1 && !ordOnly.calls[0].argv.includes("-race"),
    `${tag} (ordinary mode): want one non-race call and exit 0 even with no renewal tests; got exit `
    + `${ordOnly.status}, ${JSON.stringify(ordOnly.calls)}.`);
  const renOnly = control({ mode: "renewal", tests: TESTS, renewOut: ALL_PASS });
  check(renOnly.status === 0 && renOnly.calls.length === 1 && renOnly.calls[0].argv.includes("-race"),
    `${tag} (renewal mode): want one race call and exit 0; got exit ${renOnly.status}, ${JSON.stringify(renOnly.calls)}.`);
  // A relative GO_LOCAL_LOG_DIR is the CALLER's directory, not server/ after the runner's cd.
  const relLogs = control({ mode: "renewal", tests: TESTS, renewOut: ALL_PASS, logDir: "rel-logs" });
  const relLog = `${relLogs.root}/elsewhere/rel-logs/renewal.log`;
  check(relLogs.status === 0 && sh(`test -s '${relLog}'`).status === 0
    && sh(`test -e '${relLogs.root}/server/rel-logs'`).status !== 0,
    `${tag} (relative GO_LOCAL_LOG_DIR): want exit 0 and the log at ${relLog}, nothing under server/; got exit `
    + `${relLogs.status}.\n${relLogs.out}`);
  const badMode = control({ mode: "everything", tests: TESTS });
  check(badMode.status === 2 && badMode.calls.length === 0,
    `${tag} (unknown mode): want exit 2 and no go call; got exit ${badMode.status}.`);

  // Every failure path: non-zero exit, and the stated reason.
  const FAILS = [
    { name: "ordinary fails", args: { tests: TESTS, renewOut: ALL_PASS, ordRc: 1 }, calls: 1,
      reason: /ordinary lane exited non-zero/ },
    { name: "renewal exits non-zero after printing every PASS (tee must not mask it)",
      args: { tests: TESTS, renewOut: ALL_PASS, renewRc: 1 }, calls: 2, reason: /renewal lane exited non-zero/ },
    { name: "a discovered test has no PASS line",
      args: { tests: TESTS, renewOut: "--- PASS: TestLinkRenewOne (0.01s)\nPASS\n" }, calls: 2,
      reason: /renewal test TestLDRenewTwo did not PASS/ },
    { name: "a subtest SKIPs", args: { tests: TESTS, renewOut: `    --- SKIP: TestLinkRenewOne/sub (0.00s)\n${ALL_PASS}` },
      calls: 2, reason: /a renewal test skipped/ },
    { name: "the pattern names no test", args: { tests: "package main\n\nfunc TestUnrelated(t *testing.T) {}\n",
      renewOut: ALL_PASS }, calls: 0, reason: /no top-level test in server\/cmd\/relayium matches/ },
  ];
  for (const f of FAILS) {
    const r = control(f.args);
    check(r.status !== 0 && r.status !== null && f.reason.test(r.out) && r.calls.length === f.calls,
      `${tag} (${f.name}): want a non-zero exit matching ${f.reason} after ${f.calls} go call(s); got exit `
      + `${r.status} after ${r.calls.length}.\n${r.out}`);
  }
  sh(`rm -rf '${sandbox}'`);
}

/**
 * A race lane must be bounded and must not be allowed to try again. A retry
 * turns an intermittent race — the only kind the detector usually finds — into
 * a rerun that passes, and `continue-on-error` turns the whole lane advisory.
 */
function assertNoRetryAndFiniteTimeouts(file, name, job, text) {
  const timeout = Number(job["timeout-minutes"]);
  check(
    Number.isFinite(timeout) && timeout > 0,
    `${file}/${name}: timeout-minutes is ${JSON.stringify(job["timeout-minutes"])}, want a finite `
    + `positive number. An unbounded race job hangs for GitHub's 6-hour default.`,
  );
  check(
    /-timeout\s+\d+[ms]/.test(text),
    `${file}/${name}: the go test command has no finite \`-timeout\`, so Go's 10-minute default `
    + `per-package bound applies and reports as a test failure with a goroutine dump.`,
  );
  check(
    /-count=1/.test(text),
    `${file}/${name}: the go test command dropped \`-count=1\`, so a cached PASS can stand in for `
    + `a run that never happened.`,
  );
  check(
    !/retry|retries/i.test(text),
    `${file}/${name}: a retry appeared in the race command. A flaky race lane is a real timing `
    + `assumption; rerunning it until it passes deletes the only evidence.`,
  );
  check(
    job["continue-on-error"] === undefined,
    `${file}/${name}: continue-on-error makes this race lane advisory rather than a gate.`,
  );
  for (const step of job.steps ?? []) {
    check(
      step["continue-on-error"] === undefined,
      `${file}/${name}: a step sets continue-on-error, which lets the race lane report green `
      + `after failing.`,
    );
  }
}

// ── 4. the nightly serial lane exists, and is not a gate ────────────────────

const nightly = docs.get(NIGHTLY);
if (nightly) {
  const on = nightly.on ?? {};
  check(
    "schedule" in on && "workflow_dispatch" in on,
    `${NIGHTLY}: must run on \`schedule\` and \`workflow_dispatch\`; found ${JSON.stringify(Object.keys(on))}.`,
  );
  check(
    !("push" in on) && !("pull_request" in on),
    `${NIGHTLY}: gained a \`push\` or \`pull_request\` trigger. This is the full ~44 minute serial `
    + `account race that the eight-way split replaced — making it gating again puts that wait back `
    + `in front of every change, which is the entire thing the split was for.`,
  );

  const jobs = Object.entries(nightly.jobs ?? {});
  check(jobs.length >= 1, `${NIGHTLY}: has no jobs`);
  const text = jobs.map(([, job]) => runText(job)).join("\n");
  check(
    /-shuffle=on/.test(text),
    `${NIGHTLY}: lost \`-shuffle=on\`. Running the package in a fixed order is what the shards `
    + `already do; the shuffle is the only thing here that can surface a test that passes only `
    + `because of what ran before it.`,
  );
  check(
    /-count=1/.test(text) && !/-run\s/.test(text),
    `${NIGHTLY}: must run the WHOLE account package with -count=1 and no \`-run\` filter — a `
    + `filtered serial run cannot see cross-test state either.`,
  );
  check(
    /\.\/account\b/.test(text),
    `${NIGHTLY}: does not run ./account`,
  );
  check(
    !/retry|retries/i.test(text),
    `${NIGHTLY}: a retry appeared. An ordering-dependent failure that is retried away is exactly `
    + `the defect this lane exists to report.`,
  );
  for (const [name, job] of jobs) {
    const timeout = Number(job["timeout-minutes"]);
    check(
      Number.isFinite(timeout) && timeout > 0,
      `${NIGHTLY}/${name}: timeout-minutes is ${JSON.stringify(job["timeout-minutes"])}, want a `
      + `finite positive number.`,
    );
  }
}

// ── 5. the native split, and the path boundaries that make it real ──────────
//
// macOS and iOS shared one workflow file. `macos.yml` carried an `ios-build`
// job — two iOS xcodebuilds, an iOS UI smoke and three acceptance runs — behind
// a filter of `apps/**` plus `scripts/**`. The consequence was not a broken
// build but a permanently mis-sized one: every macOS-only change started an iOS
// runner, every iOS-only change started the macOS signing lane, and a Go-shard
// or release-script edit started both.
//
// The split is a FILE split because it had to be. A path filter is per-workflow:
// no arrangement of jobs, `if:` conditions or matrices inside one file can make
// two platforms trigger on different trees. So the correction is only real if
// two things stay true together — the jobs live in the right file, AND each
// file's filter actually selects its own platform. Either one alone is
// cosmetic, and both are invisible to YAML validity, actionlint and every other
// check in this repository.
//
// The failure this section exists to name out loud is the regression, not the
// abstraction: `ios-build` reappearing in `macos.yml`, or one native filter
// growing back to `apps/**`.

// `MACOS` and `MACOS_RELEASE` are declared at the top of this file, beside the
// concurrency prefixes their split made necessary.
const IOS = "ios.yml";
const IOS_TRANSFER_INTEROP = "ios-transfer-interop.yml";

// ── 6k's subjects, declared beside the workflows they are about ─────────────
//
// The XCTest guards that READ an app tree — a project file, a privacy manifest,
// the distribution/signing configuration, an icon set, a plist, a `.strings`
// catalog — live in the shared SwiftPM package, not in either Xcode project, so
// `xcodebuild` never runs them.
//
// Until 2026-09-21 `ios.yml` ran ten of them by `--filter`, named here one at a
// time, because the package lane watched `apps/RelayiumKit/**` and nothing else.
// That list was extended twice after reproduced hosted gaps and still named ten
// selectors against roughly thirty test files reading `apps/ios`; `macos.yml`
// had no such step at all, so an `apps/mac`-only change ran no guard. The
// package lane now watches both app trees and runs the WHOLE suite on them, and
// the hand-kept list is gone. What 6k holds is the pair of facts that replaced
// it: the package lane starts on every class of file those guards read, and
// `ios.yml` does not grow a second `swift test` back.

/** One sample per INPUT CLASS the package's guard tests read, per app tree. */
const APP_GUARD_INPUTS = [
  { lane: "ios.yml", path: "apps/ios/Relayium.xcodeproj/project.pbxproj",
    why: "the iOS project file: targets, signing settings, known regions" },
  { lane: "ios.yml", path: "apps/ios/Relayium/Info.plist",
    why: "the Local Network and camera purpose keys, and `CFBundleLocalizations`" },
  { lane: "ios.yml", path: "apps/ios/Relayium/en.lproj/InfoPlist.strings",
    why: "the English purpose sentences the system alert renders" },
  { lane: "ios.yml", path: "apps/ios/Relayium/zh-Hans.lproj/InfoPlist.strings",
    why: "the Simplified-Chinese purpose sentences" },
  { lane: "ios.yml", path: "apps/ios/Relayium/PairingScannerView.swift",
    why: "the scanner's source shape and the localization source guard" },
  { lane: "ios.yml", path: "apps/ios/RelayiumShare/ShareViewController.swift",
    why: "the extension the guards require to declare NO protected-resource key" },
  { lane: "macos.yml", path: "apps/mac/Relayium.xcodeproj/project.pbxproj",
    why: "the Mac project file the surface, hardened-runtime and version guards read" },
  { lane: "macos.yml", path: "apps/mac/Relayium/Info.plist",
    why: "the Mac bundle's declarations and localizations" },
  { lane: "macos.yml", path: "apps/mac/Relayium/Transfer/PairingCodeStart.swift",
    why: "Mac app source the surface guards pin by structure" },
];
/** The lane that owns the repository's only unfiltered `swift test`. */
const SWIFT_PACKAGE_LANE = "swift-package.yml";
/**
 * The platform roots the package suite's guard tests READ, and therefore the
 * only two its filter may span. Section 6b holds the filter to exactly these.
 */
const SWIFT_PACKAGE_READ_ROOTS = ["apps/mac", "apps/ios"];

// ── the two device shapes the UI target has to be executed on ───────────────
//
// `AdaptiveShellUITests` is the only class in `RelayiumUITests` that reads the
// size class, and every one of its cases opens by skipping unless the shell
// came up regular-width. `ios-ui-smoke` selects an iPhone and runs the whole
// target, so before `ios-ipad-shell` existed that class skipped on every hosted
// run since it was written — a green lane over a `NavigationSplitView` no CI
// run had ever drawn. A skip is not a failure and `xcodebuild` exits 0 for a
// suite that skipped entirely, so nothing went red and nothing could.
//
// Section 6q holds the repair: one job, on an iPad, scoped to that class, which
// asserts afterwards that its cases RAN.
const IOS_COMPACT_JOB = "ios-ui-smoke";
const IOS_REGULAR_WIDTH_JOB = "ios-ipad-shell";
const IOS_UI_TARGET = "RelayiumUITests";
const IOS_REGULAR_WIDTH_CLASS = "AdaptiveShellUITests";
/** The `-only-testing` identifier the iPad job must carry, and only it. */
const IOS_REGULAR_WIDTH_SELECTOR = `-only-testing:${IOS_UI_TARGET}/${IOS_REGULAR_WIDTH_CLASS}`;
/** The whole-target selection that belongs to the iPhone job alone. */
const IOS_WHOLE_UI_TARGET_SELECTOR = `-only-testing:${IOS_UI_TARGET} test`;
const SHARED_KIT = "apps/RelayiumKit/**";
const IOS_PROJECT = "-project apps/ios/Relayium.xcodeproj";
const MACOS_PROJECT = "-project apps/mac/Relayium.xcodeproj";

/**
 * A GitHub path filter compiled to a regular expression.
 *
 * `**` crosses `/`, a single `*` does not, and everything else is literal —
 * which is what makes `server/account/deviceinbox*` in web.yml match
 * `deviceinbox.go` but not a file in a subdirectory. Every regex
 * metacharacter is escaped, so `.github/workflows/go.yml` cannot match
 * `xgithub/workflows/go.yml` through an unescaped dot.
 */
function pathFilterToRegExp(pattern) {
  let re = "";
  for (let k = 0; k < pattern.length; k += 1) {
    const ch = pattern[k];
    if (ch === "*") {
      if (pattern[k + 1] === "*") { re += "[\\s\\S]*"; k += 1; } else { re += "[^/]*"; }
    } else if ("\\^$.|?+()[]{}".includes(ch)) {
      re += `\\${ch}`;
    } else {
      re += ch;
    }
  }
  return new RegExp(`^${re}$`);
}

/** Is this filter entry an exclusion? */
const isNegation = (pattern) => typeof pattern === "string" && pattern.startsWith("!");

/** The glob half of a filter entry, with any leading `!` removed. */
const filterBody = (pattern) => (isNegation(pattern) ? String(pattern).slice(1) : String(pattern));

/**
 * Would GitHub start a workflow with this `paths:` filter for a change to
 * `path`?
 *
 * ORDERED, LAST MATCH WINS — not `some()`. GitHub evaluates a `paths:` list
 * against each changed file in order and the LAST pattern that matches decides:
 * a `!` entry excludes, and a later positive entry can re-include what an
 * earlier `!` excluded. A file no pattern matches does not match at all.
 *
 * Reading the list as an unordered `some()` was correct only while no filter in
 * this repository carried a negation. Three now do — `macos.yml`, `ios.yml` and
 * `native-web-pairing.yml` each follow `apps/RelayiumKit/**` with
 * `!apps/RelayiumKit/Tests/**` — and under `some()` every file in that excluded
 * subtree would still read as triggering, because the positive pattern matches
 * it. Every trigger-matrix row below would then be judging a filter nobody had
 * actually compiled.
 *
 * WHY those exclusions exist, and every way of getting one wrong, is
 * `scripts/test/swift-ci-boundary-test.mjs`. This is only the semantics the
 * rows here are read with.
 */
const matchesFilter = (patterns, path) => {
  let matched = false;
  for (const pattern of patterns) {
    if (!pathFilterToRegExp(filterBody(pattern)).test(path)) continue;
    matched = !isNegation(pattern);
  }
  return matched;
};

/** The `push` path filter of a governed workflow, or null when it has none. */
function pathsOf(file) {
  const push = docs.get(file)?.on?.push;
  const paths = push && typeof push === "object" ? push.paths : undefined;
  return Array.isArray(paths) ? paths : null;
}

/**
 * A job with the whole-line shell comments inside its `run:` block scalars
 * removed.
 *
 * The YAML parser above already drops YAML comments, but a `run: |` block is a
 * SCALAR: everything indented under it survives verbatim, shell comments
 * included. So a job that merely explains a command owns it as far as a text
 * search is concerned, and every ownership question in this file is a text
 * search — `-project apps/mac/Relayium.xcodeproj` written inside a `# was:`
 * line in ios.yml would report macOS as having two heavy owners, which is a
 * red board for a workflow that builds nothing of the sort. It fails the other
 * way too: the real command deleted and its rationale left behind reads as a
 * platform still being built.
 *
 * These jobs comment themselves at length and name the commands they are
 * explaining, so this is not hypothetical tidiness — it is the difference
 * between asserting the code and agreeing with the prose.
 */
function withoutRunComments(job) {
  const copy = structuredClone(job ?? null);
  for (const step of copy?.steps ?? []) {
    if (typeof step?.run !== "string") continue;
    step.run = step.run.split("\n").filter((line) => !/^\s*#/.test(line)).join("\n");
  }
  return copy;
}

/** Everything a job actually executes or configures, comments excluded. */
const jobBodies = (file) => Object.entries(docs.get(file)?.jobs ?? {})
  .map(([name, job]) => [name, JSON.stringify(withoutRunComments(job))]);

const workflowBody = (file) => jobBodies(file).map(([, body]) => body).join("\n");

// 5a. The regression, named. A job key is the one thing a reader greps for and
//     the one thing a careless revert restores wholesale.
if (docs.get(MACOS)) {
  check(
    !("ios-build" in (docs.get(MACOS).jobs ?? {})),
    `${MACOS} contains an \`ios-build\` job again. That job is iOS work — two iOS xcodebuilds, `
    + `the iOS UI smoke and the local/built-App acceptance — and it belongs to ${IOS}. While it `
    + `lives here, macOS and iOS share one path filter and one set of triggers, so the two `
    + `platforms cannot be started independently no matter what the filter says.`,
  );
}

// 5b. And the same regression arriving under a different job name. The name is
//     a convention; compiling the iOS project is the fact.
if (docs.get(MACOS)) {
  const offenders = jobBodies(MACOS)
    .filter(([, body]) => body.includes("apps/ios/"))
    .map(([name]) => name);
  check(
    offenders.length === 0,
    `${MACOS} job(s) ${offenders.join(", ")} reference \`apps/ios/\`. Renaming \`ios-build\` does `
    + `not separate the platforms; hosting ANY iOS build, test or acceptance in the macOS `
    + `workflow puts it back behind the macOS triggers.`,
  );
}
if (docs.get(IOS)) {
  const offenders = jobBodies(IOS)
    .filter(([, body]) => body.includes("apps/mac/"))
    .map(([name]) => name);
  check(
    offenders.length === 0,
    `${IOS} job(s) ${offenders.join(", ")} reference \`apps/mac/\`. The iOS workflow must contain `
    + `only iOS-relevant jobs, or the split is one-directional and macOS work runs twice.`,
  );
}

// 5c. Moved, not copied. A "split" that leaves the old job in place doubles the
//     cost of the exact change it was meant to make cheaper, and both runs are
//     green so nothing reports it.
for (const [marker, homes, what] of [
  [IOS_PROJECT, [IOS, IOS_TRANSFER_INTEROP], "the iOS app build and built-App acceptance"],
  [MACOS_PROJECT, [MACOS], "the macOS app build"],
]) {
  const hosts = GOVERNED.map((g) => g.file).filter((file) => workflowBody(file).includes(marker));
  check(
    deepEqual(hosts.sort(), homes.toSorted()),
    `${what} (\`${marker}\`) runs in ${hosts.length ? hosts.join(", ") : "no governed workflow"}; `
    + `want exactly ${homes.join(", ")}. The dedicated interop host is intentional; any other `
    + `duplicate is a paid runner with no new evidence, while zero stops building the platform.`,
  );
}

// 5d. The shared package is the one tree that must start BOTH. It is what each
//     app compiles against, and a change there can break either one alone —
//     which is precisely what a per-platform split risks losing.
for (const file of [MACOS, IOS]) {
  const paths = pathsOf(file);
  if (paths === null) continue;
  check(
    paths.includes(SHARED_KIT),
    `${file}'s path filter does not list \`${SHARED_KIT}\`. RelayiumKit is shared source: a change `
    + `there compiles into both native apps, so it must start both native workflows. Dropping it `
    + `from one leaves that app's compatibility with the shared package unproven until something `
    + `else happens to touch it.`,
  );
}

// 5e. And the boundary in the other direction, asserted on the FILTER rather
//     than on the list, so a coarse `apps/**` fails here even though it "looks
//     like" it contains the right trees.
if (pathsOf(MACOS)) {
  check(
    !matchesFilter(pathsOf(MACOS), "apps/ios/Relayium/RelayiumApp.swift"),
    `${MACOS}'s path filter matches iOS-only source. An iOS change would start the macOS signing `
    + `lane — the certificate import, the notarization-capable jobs, the UI smoke — for a tree `
    + `none of them build. This is what \`apps/**\` did before the split.`,
  );
}
if (pathsOf(IOS)) {
  check(
    !matchesFilter(pathsOf(IOS), "apps/mac/Relayium/AccountView.swift"),
    `${IOS}'s path filter matches macOS-only source, so a macOS change starts an iOS runner that `
    + `builds nothing it changed.`,
  );
}

// 5f. Each filtered workflow must be able to see edits to ITSELF. Without this,
//     a change to a workflow's own triggers is merged having never run under
//     them.
for (const { file } of GOVERNED) {
  const paths = pathsOf(file);
  if (paths === null) continue;
  check(
    matchesFilter(paths, `.github/workflows/${file}`),
    `${file}'s path filter does not match \`.github/workflows/${file}\`, so an edit to this `
    + `workflow does not run this workflow and lands unverified.`,
  );
}

// 5g. The whole trigger matrix, as behaviour rather than as a list of globs.
//
// Each row is a real file and the exact set of governed, path-filtered
// workflows that must start for it. Asserting the SET is what catches a filter
// that is too broad and one that is too narrow with the same check — a list
// comparison only ever catches the edit somebody already thought about.
//
// Workflows with no path filter are excluded and asserted separately below;
// they run on everything by construction, so including them would make every
// row say the same thing.
//
// The matrix is evaluated against a WORLD rather than against module state, for
// the same reason section 6 is: section 8 hands it a mutated copy of the real
// workflows and requires the matching row to complain. A row asserted only
// against the checked-in filters is a row nobody has ever seen fail, and the
// most expensive thing in this file is a check that passes because it cannot
// fail. The real-world call sits next to section 6's and section 7's, just
// above section 8.
// The rows themselves now live in `scripts/test/fixtures/ci-path-selection.mjs`
// and are imported at the top of this file. They moved for one reason: the
// merge gate's `scripts/ci/select-lanes.mjs` reads the same filters with a
// DIFFERENT implementation — a narrow `on.push.paths` extractor and a
// split-on-stars glob compiler, where this file carries a general parser and a
// character-walking one — and `scripts/test/ci-lane-selector-test.mjs` judges it
// against these same rows.
//
// One oracle, two readers. Emptying a lane's `push.paths` now fails in BOTH
// files from one edit, which is what makes the agreement evidence rather than a
// coincidence. Had the rows been copied into the second test, a copy-paste
// would have made the two implementations agree while both were wrong — and the
// gate would be selecting lanes by a rule nothing had ever contradicted.
//
// A shared DATA fixture, not shared implementation. The repository's
// no-shared-parser convention is about not needing `npm ci` in front of a guard
// that gates every pull request; an imported array needs nothing installed.

// Two rows spell out what this file otherwise reads through a constant, because
// a fixture that imports its own subject is not a fixture. Assert the constants
// and the rows still name the same files, or the extraction can drift silently.
check(
  PATH_MATRIX.some(([path]) => path === FUZZ_INVENTORY),
  `the shared path-selection fixture has no row for \`${FUZZ_INVENTORY}\`. That row is what `
  + `keeps the fuzz campaign's discovery script starting the Go lane and nothing else; the `
  + `fixture spells the path out, so a rename here that the fixture did not follow leaves the `
  + `row asserting something about a file that no longer exists.`,
);
check(
  PATH_MATRIX.some(([path]) => path === `.github/workflows/${FUZZ_NIGHTLY}`),
  `the shared path-selection fixture has no row for \`.github/workflows/${FUZZ_NIGHTLY}\`.`,
);

/**
 * Every trigger-matrix disagreement about one world, as messages.
 *
 * Mirrors `platformBoundaryFailures`: it returns rather than pushes, so the
 * real world's messages become failures at the call site and section 8 can
 * assert that a specific mutation produces a specific row's complaint.
 */
function pathMatrixFailures(world) {
  const out = [];
  const filtered = world.governed
    .map((entry) => entry.file)
    .filter((file) => wPaths(world, file) !== null);
  for (const [path, want, why] of PATH_MATRIX) {
    const got = filtered.filter((file) => matchesFilter(wPaths(world, file), path)).sort();
    if (deepEqual(got, [...want].sort())) continue;
    out.push(
      `changing "${path}" starts [${got.join(", ")}]; want [${want.join(", ")}] — ${why}.`,
    );
  }
  return out;
}

// The matrix above only means what it says if the excluded workflows really are
// the unfiltered ones. `repo-hygiene.yml` is deliberately unfiltered: it hosts
// this guard and the other cross-cutting ones, which must run on every change.
// Only files that actually parsed are judged here: a workflow reported missing
// above has no filter to have lost, and saying so twice buries the real cause.
const unfiltered = GOVERNED.map((g) => g.file)
  .filter((file) => docs.has(file) && pathsOf(file) === null);
check(
  deepEqual(unfiltered, ["compat.yml", "repo-hygiene.yml"]),
  `the set of governed workflows with NO push path filter is [${unfiltered.join(", ")}], want `
  + `[compat.yml, repo-hygiene.yml]. Both are unfiltered ON PURPOSE and for the same reason — `
  + `repo-hygiene hosts the cross-cutting guards, compat hosts the wire-compatibility contract `
  + `every platform must pass — and both must therefore run on every change. A THIRD entry is a `
  + `workflow that lost its filter and now runs on every change, including the macOS signing `
  + `lane on a documentation edit; a MISSING entry is a gate that a new platform root can `
  + `bypass by existing. Either way the matrix above stops covering it.`,
);

// ── 6. platform roots, their owners, and the always-on compatibility gate ───
//
// Section 5 separated macOS from iOS. This section states the RULE that split
// was an instance of, so the next platform cannot re-create the same defect by
// simply existing.
//
//   * A platform root (`apps/mac`, `apps/ios`, one day `apps/android` or
//     `apps/windows`) has exactly ONE heavy owner: the workflow that builds,
//     tests, signs and releases it. Nothing else may start a heavy build from
//     that root.
//   * `apps/RelayiumKit` is APPLE-SHARED, not cross-platform. It is Swift and it
//     links WebRTC and Sodium through SwiftPM, so it fans out to macOS AND iOS
//     deliberately — and to nothing else.
//   * A truly cross-platform contract — the cross-language wire vectors — is a
//     FAST gate and lives in `compat.yml`, which has no path filter at all, so
//     every platform present and future has to pass it. Unfiltered and
//     fail-closed is what this file asserts; making a red result block a merge
//     is branch protection (`compat / wire-vectors`) and is not asserted here.
//   * A workflow may watch a tree it does not own only when that tree is a real
//     INPUT — something the run reads, compiles or serves. `apps/mac/**` is the
//     worked example in the other direction: `native-web-pairing.yml` speaks FOR
//     the macOS app, builds `apps/RelayiumKit` and `server` and serves the Web
//     bundle, and never reads a file under `apps/mac/`, so it does not watch it.
//   * A future platform root and the workflow that owns it are created in the
//     SAME commit. A root with no workflow is source nothing compiles; a
//     workflow with no root is a placeholder reporting a green check for a
//     platform that does not exist, which reads as coverage and is not.
//
// All of it is invisible to YAML validity and to actionlint: a filter widened
// back to `apps/**` is valid, a placeholder `echo` job is valid, and
// `continue-on-error: true` on the compatibility gate is valid. Section 8 then
// mutates the parsed workflows to prove every assertion here can actually fail,
// because a policy check that cannot fail is the most expensive kind of green.
//
// `docs/CI-PLATFORM-BOUNDARY.md` is the prose. This is the enforcement.

const COMPAT = "compat.yml";
const NWP = "native-web-pairing.yml";
const SHARED_APPLE_ROOT = "apps/RelayiumKit";
const SHARED_APPLE_SAMPLE = "apps/RelayiumKit/Sources/RelayiumKit/Crypto/SealedBox.swift";
const VECTOR_COMMAND = "npm run test:vectors";
const VECTOR_WRITER = "gen:vectors";

/**
 * The working directory both halves of the gate must declare.
 *
 * `web/` is where `package.json`, `package-lock.json` and the generators live.
 * An install that lands anywhere else reports success and leaves the gate's own
 * `node_modules` missing.
 */
const VECTOR_WORKDIR = "web";

/** Any dependency install, in the forms npm accepts — including the wrong ones. */
const ANY_NPM_INSTALL = /\bnpm\s+(ci|install|i)\b/;
/** The only form allowed here: resolved from the lockfile, never rewriting it. */
const VECTOR_INSTALL = /\bnpm\s+ci\b/;

/**
 * The flags that keep the gate's install minimal and deterministic, each with
 * the reason it is not decoration.
 */
const VECTOR_INSTALL_FLAGS = [
  {
    flag: "--omit=dev",
    why: "the generators import `libsodium-wrappers` and nothing else from the tree; pulling Vite, "
      + "Vitest, svelte-check and TypeScript into a seconds-long contract check is how it becomes "
      + "slow enough that somebody adds the path filter it must never have",
  },
  {
    flag: "--ignore-scripts",
    why: "`yargs` and `get-caller-file` in that closure declare `prepare` scripts shelling out to "
      + "`tsc` and `npm run compile`, and TypeScript is a devDependency `--omit=dev` deliberately "
      + "does not install",
  },
];

/**
 * The job key `compat.yml` declares — and therefore the second half of the
 * required status context `compat / wire-vectors`, which GitHub renders as the
 * workflow's `name:` and the job key joined.
 *
 * It is a constant here because section 6j asserts BOTH directions of it: that
 * `compat.yml` still declares this exact name, and that nothing else in this
 * repository declares it too.
 */
const COMPAT_JOB = "wire-vectors";

const RELEASE = "release.yml";

/**
 * The commit-message escape that used to live in `ios.yml`, and the general
 * shape of it.
 *
 * `[macos-only]` in a `main` commit message skipped the iOS build outright. The
 * literal marker is rejected so it cannot come back verbatim; the regexp is
 * rejected so it cannot come back as `[skip-ios]`, `[no-ci]` or any other
 * spelling of "let whoever writes the commit decide whether the gate runs".
 */
const SKIP_MARKER = "[macos-only]";
const COMMIT_MESSAGE_CONDITION = /head_commit|event\.commits|\.message\b/;

/**
 * Apple's own notarization wait, READ from the script that submits.
 *
 * `notarize-stage`'s bound is the one in this repository that must not be
 * tightened toward its observed runtime. Every real notarization in recent
 * history finished in about a minute, so an observation-scaled bound would be
 * about two — and it would kill a legitimately slow notary day mid-wait and
 * burn the submission. The floor is therefore whatever `--wait --timeout` the
 * submitting script itself allows, parsed rather than remembered: a comment
 * asserting "keep this above 45m" goes stale the moment somebody edits the
 * script, and the two numbers disagreeing silently is the whole failure.
 */
const NOTARY_SCRIPT = "apps/mac/scripts/notarize-dmg.sh";
const notaryWaitMinutes = (() => {
  try {
    return Number(readFileSync(resolve(repoRoot, NOTARY_SCRIPT), "utf8").match(/--timeout\s+(\d+)m\b/)?.[1]);
  } catch {
    return NaN;
  }
})();

/**
 * The most expensive lanes, and what a job in each is allowed to cost.
 *
 * `max` is asserted in BOTH directions for the same reason the self-host bound
 * is: absent, a job inherits GitHub's six-hour default; declared at some large
 * number, it is that same default wearing a disguise. The ceilings sit above
 * the real bounds these files carry, so a deliberate adjustment is possible and
 * a six-hour "bound" is not.
 *
 * An entry declares EITHER a whole-file `max`/`why`, when every job in the file
 * does comparable work, OR a `jobs` map naming each job separately. `macos.yml`
 * needs the second form and would be actively harmed by the first: its jobs run
 * from a sub-minute checkout to a double `xcodebuild` plus signing and a
 * 45-minute Apple notarization wait. One number covering all six would have to
 * be the largest of them, which is how a `contract` job that hangs for an hour
 * reads as "inside budget" — a global bound raised until it fits the slowest
 * job is the six-hour default with extra steps. The `jobs` form is also checked
 * for COMPLETENESS in both directions: a job with no entry fails, and an entry
 * naming no job fails, so adding or renaming a macOS job forces a decision
 * instead of silently landing in the unbudgeted case.
 *
 * Every `max` below sits above a bound this repository has actually measured;
 * the reasoning for each number is in the comment above the job it bounds.
 */
const RUNNER_BUDGETS = [
  {
    // Declared 25 for its one job. The command it runs is the one that used to
    // sit in `macos.yml`'s `test` job, whose 59 recorded runs took
    // 5.5 minutes at worst for this suite PLUS four release-script tests — so
    // 5.5 bounds this command from above. 30 leaves room for a cold SwiftPM
    // resolve and a fresh WebRTC/Sodium fetch on a runner with no cache.
    //
    // The `jobs` form rather than a file-wide `max`, even with one job, is
    // deliberate: it is what makes a SECOND job added to this workflow fail
    // until somebody budgets it.
    file: "swift-package.yml",
    why: "a PAID macOS runner is held by a `swift test` that never exits",
    jobs: {
      "swift-test": {
        max: 30,
        why: "a PAID macOS runner is held by a `swift test` that never exits",
      },
    },
  },
  {
    // Declared 30 for its one job: a cold SwiftPM package build (about two
    // minutes hosted for `swift-package.yml`'s identical build), a setup-go,
    // and nine filtered cases measured at ~40s locally including their small Go
    // builds. The budget is the declared value itself — the hosted cost is
    // unmeasured until the lane's first run — and the `jobs` form makes a
    // second job fail here until somebody budgets it.
    file: "inbox-swift-interop.yml",
    why: "a PAID macOS runner is held by a `swift test` that never exits",
    jobs: {
      "swift-live-interop": {
        max: 30,
        why: "a PAID macOS runner is held by a `swift test` that never exits, or by a live "
          + "interop helper whose own bounded teardown failed",
      },
    },
  },
  {
    // Declared 45. Worst case is eight rounds each preceded by a 65s wait for
    // the server's own per-IP WebSocket join budget, on top of the Swift, Go
    // and Vite builds and a Chrome install. 60 is above that and far below the
    // 6-hour default this list exists to replace.
    //
    // It is here because 6l requires every governed macOS job to be budgeted
    // somewhere, and this was the only one that was not — not by decision, but
    // because the list predates the acceptance moving into its own file.
    file: NWP,
    max: 60,
    why: "a PAID macOS runner is held by an acceptance whose Chrome, Go server or Swift peer "
      + "never became ready, with two live clients waiting on each other",
  },
  {
    // The root contract tree's lane. The `jobs` form, even though two of the
    // three jobs are alike, because the third is not: `swift-contract` holds a
    // PAID macOS runner and pays a cold SwiftPM build, while the other two are
    // free Linux runners doing seconds of work. A single file-wide ceiling
    // would have to be the macOS number, and a `go-contract` job wedged for
    // twenty minutes would then read as inside budget — the exact shape 6i
    // exists to reject. It is also what makes a FOURTH consumer job fail here
    // until somebody budgets it.
    file: "contracts.yml",
    why: "a runner is held by a contract check that never exits",
    jobs: {
      // Declared 10. A checkout, `setup-go`, one package build and two named
      // test functions reading one JSON document. 15 leaves room for a cold
      // module download on a runner with no cache.
      "go-contract": {
        max: 15,
        why: "a runner is held by a `go test` selector that never exits, in a job whose real "
          + "work is two test functions reading one JSON document",
      },
      // Declared 10. `npm ci --ignore-scripts` for the Vitest closure, then one
      // Vitest file. Same shape, same evidence, same ceiling as the Go half.
      "web-contract": {
        max: 15,
        why: "a runner is held by an `npm ci` or a single Vitest file that never exits",
      },
      // Declared 25, and deliberately the same number `swift-package.yml`'s own
      // job carries: this job pays the SAME cold SwiftPM resolve and package
      // build before running five filtered test cases measured at 0.7s
      // locally. 30 is therefore that job's ceiling reused for the same cold
      // build, not a fresh measurement of five test cases.
      "swift-contract": {
        max: 30,
        why: "a PAID macOS runner is held by a `swift test` that never exits",
      },
    },
  },
  {
    // The deploy contract's lane. One job, one free Ubuntu runner: the `jobs`
    // form is not needed, and a single file-wide ceiling is honest here in a way
    // it would not be for `contracts.yml`, whose three jobs differ by an order
    // of magnitude in cost.
    //
    // Declared 10. A checkout, `setup-go`, one package build and a handful of
    // test functions driving an in-process HTTP handler — plus one deliberate
    // ~2s wait where the frozen readiness database bound is allowed to elapse.
    // 15 leaves room for a cold module download on a runner with no cache.
    file: "ops-deploy-contract.yml",
    max: 15,
    why: "a runner is held by a `go test` selector that never exits, in a job whose real work is "
      + "a handful of test functions driving one HTTP handler in process",
  },
  {
    file: IOS,
    jobs: {
      "ios-build": {
        max: 40,
        why: "a PAID macOS runner is held by either of the two unsigned compile graphs",
      },
      // Declared 65 PER SHARD, and two shards. `shards` is the number of PAID
      // runners one run of this job starts; 6u holds the matrix to exactly it.
      // The split adds about 6.9 runner-minutes per run (~20%, an estimate
      // until hosted runs measure it) for a ~12-minute shorter critical path.
      // 65 is the step bounds in order — Xcode selection 10, simulator boot
      // barrier 5 (6v), test 48 — plus 2 for checkout, the shard proof and the
      // uploads. It is a ceiling for a hang, not a nominal run time.
      "ios-ui-smoke": {
        max: 65,
        shards: 2,
        why: "a PAID macOS runner is held by an iPhone simulator or UI test that never exits",
      },
      // Declared 50: Xcode selection 10, simulator boot barrier 5 (6v), test 30,
      // plus 5 for checkout, the run proof and the uploads. One class of six
      // cases against one booted iPad simulator, plus the same UI-test-target
      // build `ios-ui-smoke` pays for. Strictly less work than that job, so its
      // bound is an upper limit here; 50 is what this scope justifies while
      // still absorbing a cold build and a slow first boot.
      "ios-ipad-shell": {
        max: 50,
        why: "a PAID macOS runner is held by an iPad simulator that never boots, or by a "
          + "regular-width UI test waiting on a sidebar that never appeared",
      },
    },
  },
  {
    file: IOS_TRANSFER_INTEROP,
    jobs: {
      "ios-transfer-acceptance": {
        max: 45,
        why: "a PAID macOS runner is held by a transfer peer, local server or built-App session "
          + "that never exits",
      },
    },
  },
  {
    file: RELEASE,
    max: 60,
    why: "a wedged release job holds a runner with the release signing key materialized on disk",
  },
  {
    file: MACOS,
    why: "a PAID macOS runner is held by work that will never finish",
    jobs: {
      // Declared 10. A checkout on Ubuntu for push, pull request and the merge
      // gate (dispatched or not); on macOS only when a release input reaches
      // `xcodebuild -showBuildSettings` (6t). Still budgeted: on those runs it
      // is a PAID runner, and 6l counts any `runs-on` that can name macOS.
      contract: {
        max: 15,
        why: "a PAID macOS runner is held by a release-contract check that reads a project file",
      },
      // Declared 10. The unfiltered `swift test` moved to `swift-package.yml`;
      // what is left is a checkout, two `-version` probes and four
      // release-script tests that run entirely against mocked
      // `codesign`/`hdiutil`/`xcrun` binaries and build nothing. The recorded
      // evidence — 59 runs at 5.5 minutes worst — measured this job WITH the
      // `swift test`, so it bounds the remaining subset from above; 15 is that
      // bound rounded up, not a fresh measurement.
      test: {
        max: 15,
        why: "a PAID macOS runner is held by a release-script test that never exits, in a job "
          + "whose remaining work is four mocked shell tests",
      },
      // Declared per shard in the matrix: 30 and 35.
      "ui-smoke": {
        max: 45,
        why: "a PAID macOS runner is held by a UI test driving an app that never became ready, "
          + "with the signing certificate materialized in a keychain on disk",
      },
      // Declared 60, the widest bound here and the widest measured spread.
      "signed-build": {
        max: 75,
        why: "a PAID macOS runner is held by a wedged build with the Developer ID signing key "
          + "materialized in a keychain on disk",
      },
      // `notarize-stage` and `publish` are NOT here any more, and their absence
      // is enforced rather than merely true: the per-job completeness rule
      // below fails in both directions, so a budget naming a job `macos.yml`
      // no longer declares is a failure, and either job restored into this file
      // would land in the unbudgeted case and fail there. Their budgets moved
      // WITH them, to the `macos-release.yml` entry below — 6m asserts that
      // they moved rather than were dropped.
    },
  },
  {
    // The manual release entry point. Its two executable jobs are the two most
    // dangerous in this repository, and they are the same two jobs — with the
    // same work, the same evidence and the same numbers — that used to sit in
    // `macos.yml`. The ceilings moved unchanged; nothing about what they do
    // changed, only which file they are in.
    //
    // The `jobs` form, and not because the two differ by an order of magnitude
    // — though they do. It is what makes a THIRD job added to the release lane
    // fail until somebody budgets it, which on a workflow that notarizes and
    // publishes is the case worth forcing a decision on.
    file: MACOS_RELEASE,
    why: "a runner is held by a release step that will never finish",
    jobs: {
      // The reusable call. A caller job declares no `timeout-minutes` — GitHub
      // rejects a workflow whose `uses:` job carries one — so it is budgeted
      // by exemption rather than by a number, and the exemption is asserted:
      // the loop below requires a caller job to declare no bound at all, and
      // every job the call actually starts is budgeted under `macos.yml`.
      // Declared 10. A free Linux runner that reads the API, downloads and
      // digest-checks one signed-build zip (a few hundred MB at most) and
      // decides where the DMG comes from; it is the first thing every release
      // waits for, so it must give up quickly.
      preflight: {
        max: 15,
        why: "every release waits behind a reuse decision whose API read or artifact download "
          + "never returns",
      },
      build: {
        caller: true,
        why: "a reusable call cannot carry its own bound; the jobs it starts are budgeted in "
          + "`macos.yml`",
      },
      // Declared 55: Apple's own `--wait --timeout 45m`, plus the stapling,
      // assessment, staging and upload that follow it. Deliberately the one
      // bound in this file NOT scaled from observed runtime — see the comment
      // on the job.
      "notarize-stage": {
        max: 70,
        why: "a PAID macOS runner is held by a notarization submission that never returns, with "
          + "the notary API key materialized on disk",
        min: notaryWaitMinutes,
        minSource: `\`${NOTARY_SCRIPT}\`'s own \`--wait --timeout\``,
        minWhy: "a bound at or below Apple's wait kills a slow-but-succeeding notarization "
          + "mid-wait and burns the submission, which is a worse outcome than the runner time it "
          + "saves",
      },
      // Declared 50. A free Linux runner, and the least recoverable job here.
      // It used to be 15 and hand the candidate's merge gate to a human; it
      // now WAITS for that gate, which selects the Go lane (21m46s measured on
      // 1741bca3e) for every release-metadata candidate.
      publish: {
        max: 60,
        why: "a half-finished publication holds a runner while the release it was supposed to "
          + "announce is neither published nor visibly failed",
      },
    },
  },
];

/**
 * Every minute value a job's `timeout-minutes` can actually take at run time.
 *
 * A plain `timeout-minutes: 60` has one. `macos.yml`'s `ui-smoke` declares
 * `timeout-minutes: ${{ matrix.timeout }}`, which is not a number at all: the
 * real bounds are the `timeout` of each `strategy.matrix.include` entry, and
 * `Number("${{ matrix.timeout }}")` is `NaN`. Reading the declared string alone
 * would therefore report the shard-per-shard bounds this file deliberately
 * carries as "not a finite positive number" — so a budget that could not
 * resolve a matrix would push whoever hit it toward deleting the matrix and
 * declaring one flat number, which is the outcome this whole section exists to
 * prevent.
 *
 * Returns `{ unresolved }` rather than an empty list when the expression names
 * a matrix the job does not have. An empty list would make every assertion
 * below iterate over nothing and pass, which is a silent non-assertion.
 */
function timeoutValues(job) {
  const raw = job["timeout-minutes"];
  const key = typeof raw === "string"
    ? raw.trim().match(/^\$\{\{\s*matrix\.([A-Za-z0-9_-]+)\s*\}\}$/)?.[1]
    : undefined;
  if (key === undefined) {
    return { values: [{ where: "timeout-minutes", declared: JSON.stringify(raw), value: Number(raw) }] };
  }
  const include = job.strategy?.matrix?.include;
  if (!Array.isArray(include) || include.length === 0) return { unresolved: key };
  return {
    values: include.map((entry, index) => ({
      where: `include[${index}]'s \`${key}\` (read by \`timeout-minutes\`)`,
      declared: JSON.stringify(entry?.[key]),
      value: Number(entry?.[key]),
    })),
  };
}

/** This file, and the unfiltered workflow that has to execute it. */
const SELF_TEST = "scripts/test/ci-event-policy-test.mjs";
const SELF_HOST = "repo-hygiene.yml";
const SELF_COMMAND = `node ${SELF_TEST}`;
/** Minutes. This file parses a handful of small YAML documents; it needs seconds. */
const SELF_TIMEOUT_MAX = 10;

/** The platform roots that exist today, and the one workflow that owns each.
 *  `appleShared` marks the platforms that compile the Apple-shared Swift
 *  package; the shared-package fan-out rules in 6c apply to exactly those. */
const PLATFORM_OWNERS = [
  {
    label: "macOS",
    root: "apps/mac",
    workflow: MACOS,
    marker: MACOS_PROJECT,
    sample: "apps/mac/Relayium/AccountView.swift",
    appleShared: true,
  },
  {
    label: "iOS",
    root: "apps/ios",
    workflow: IOS,
    marker: IOS_PROJECT,
    sample: "apps/ios/Relayium/RelayiumApp.swift",
    appleShared: true,
    buildHosts: [IOS, IOS_TRANSFER_INTEROP],
  },
  {
    // The marker is the Gradle task only `android.yml` may invoke in workflow
    // text: the interop lane builds the same APK, but through
    // `scripts/android-interop-acceptance.sh`, exactly as the pairing lane
    // hides its `swift build` inside its acceptance script — so the "one heavy
    // owner" rule keeps meaning one WORKFLOW hosts the platform build.
    label: "Android",
    root: "apps/android",
    workflow: "android.yml",
    marker: ":app:assembleDebug",
    sample: "apps/android/app/src/main/kotlin/com/relayium/android/MainActivity.kt",
    appleShared: false,
  },
];

/**
 * The platform roots that do NOT exist yet, named here on purpose.
 *
 * Naming them is what turns "nothing to check" into a checkable rule: today the
 * assertion is that neither the root nor its workflow exists, and the moment
 * either appears alone this file says so. `build` is the evidence that the
 * workflow does real work rather than echoing — the one property a placeholder
 * cannot fake without becoming a real build.
 */
const FUTURE_PLATFORMS = [
  // Android graduated to PLATFORM_OWNERS in the commit that created
  // `apps/android/` and `android.yml` together, exactly as this list's header
  // said it must.
  {
    label: "Windows",
    root: "apps/windows",
    workflow: "windows.yml",
    // A real file in the client as it was actually built. The placeholder here
    // was `apps/windows/Relayium/App.xaml.cs`, written when nobody had chosen a
    // toolchain; it named a WinUI/C# layout the client does not have, so a
    // filter check against it would have been testing a path that never exists.
    sample: "apps/windows/src/main/main.ts",
    // Widened for the toolchain that was actually chosen. The original
    // alternation covered .NET, C++ and Rust and would have rejected any
    // JavaScript-hosted desktop build — not because such a build is a
    // placeholder, but because the list predated the decision. `electron-builder`
    // is the command that produces the installer, and it cannot be satisfied by
    // an `echo`.
    build: /msbuild|dotnet\s|cargo\s|cmake\b|signtool|Invoke-Pester|electron-builder/,
  },
];

/** Every workflow file on disk, with whole-line comments removed. */
const stripComments = (text) => text.split("\n").filter((line) => !/^\s*#/.test(line)).join("\n");
const workflowTexts = new Map(
  readdirSync(workflowsDir)
    .filter((name) => /\.ya?ml$/.test(name))
    .map((name) => [name, stripComments(readFileSync(resolve(workflowsDir, name), "utf8"))]),
);

/**
 * The directories directly under `apps/`, read from disk rather than listed.
 *
 * This is what makes the future-platform rule non-vacuous: the day somebody
 * runs `mkdir apps/android`, this set changes and the checks below have
 * something to disagree with. A hard-coded list could not notice.
 */
const appRoots = (() => {
  try {
    return readdirSync(resolve(repoRoot, "apps"), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => `apps/${entry.name}`)
      .sort();
  } catch {
    return [];
  }
})();

/**
 * Every XCTest class the iOS UI-test target declares, read from disk.
 *
 * Section 6q requires `ios.yml`'s iPad job to select exactly
 * `RelayiumUITests/${IOS_REGULAR_WIDTH_CLASS}` with `-only-testing`, and
 * `xcodebuild` treats an `-only-testing` identifier that resolves to nothing
 * the same way `swift test` treats an unmatched `--filter`: it runs zero tests
 * and exits 0. So the class is checked against the file that declares it, and
 * carried in the world so section 8 can rename it away and require the
 * complaint.
 *
 * The same shallow `class X:` scan the Swift target gets, for the same reason:
 * this needs the declared names, not a parse.
 */
const IOS_UI_TEST_DIR = "apps/ios/RelayiumUITests";
const iosUITestClasses = (() => {
  const out = new Set();
  let names = [];
  try {
    names = readdirSync(resolve(repoRoot, IOS_UI_TEST_DIR), { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".swift"))
      .map((entry) => entry.name);
  } catch {
    return [];
  }
  for (const name of names) {
    let text;
    try {
      text = readFileSync(resolve(repoRoot, IOS_UI_TEST_DIR, name), "utf8");
    } catch {
      continue;
    }
    for (const line of text.split("\n")) {
      const declared = line.match(/\bclass\s+([A-Za-z_][A-Za-z0-9_]*)\s*:/);
      if (declared) out.add(declared[1]);
    }
  }
  return [...out].sort();
})();

/**
 * Does the fuzz campaign's discovery script exist?
 *
 * Read from disk rather than assumed, and carried in the world below, so
 * section 8 can delete it and require section 7 to notice. A campaign whose
 * inventory script is gone still parses, still schedules and still declares a
 * matrix expression — it just discovers nothing, every night, quietly.
 */
const fuzzInventoryExists = (() => {
  try {
    readFileSync(resolve(repoRoot, FUZZ_INVENTORY));
    return true;
  } catch {
    return false;
  }
})();

/**
 * Everything the checks below read, in one mutable value.
 *
 * Section 8 hands them a MODIFIED copy of this and requires them to complain,
 * which is only possible because they read a world rather than module state.
 */
function realWorld() {
  return {
    governed: GOVERNED.map((entry) => ({ ...entry })),
    budgetOnly: [...BUDGET_ONLY],
    docs: new Map([...docs].map(([file, doc]) => [file, structuredClone(doc)])),
    texts: new Map(workflowTexts),
    roots: new Set(appRoots),
    inventory: fuzzInventoryExists,
    uiTestClasses: [...iosUITestClasses],
  };
}

const wPaths = (world, file) => {
  const push = world.docs.get(file)?.on?.push;
  const paths = push && typeof push === "object" ? push.paths : undefined;
  return Array.isArray(paths) ? paths : null;
};

/** Would a change to `path` start `file`? Compiled globs, not list membership. */
const wTriggers = (world, file, path) => {
  const paths = wPaths(world, file);
  if (paths === null) return world.docs.has(file); // no filter: everything starts it
  return matchesFilter(paths, path);
};

// Comments stripped for the same reason as in `jobBodies`: ownership is a
// property of the command, not of the sentence next to it.
const wJobBody = (world, file) =>
  JSON.stringify(Object.values(world.docs.get(file)?.jobs ?? {}).map(withoutRunComments));

/**
 * The job keys a workflow file declares — for EVERY workflow file on disk, not
 * only the parsed ones.
 *
 * A parsed document is authoritative wherever one exists. For every other file
 * the keys are read structurally from the comment-stripped source: the `jobs:`
 * mapping at column 0, then the keys at the first indentation level under it,
 * stopping at the next top-level key. Deeper lines — a step's `name:`, a `run:`
 * block scalar's contents — sit at a greater indent and are skipped by the
 * equality test, so a command that happens to contain `wire-vectors:` cannot be
 * mistaken for a job.
 *
 * Reading the text rather than parsing every file is deliberate. The parser in
 * this file covers the subset the GOVERNED workflows use and THROWS on anything
 * it does not understand, so parsing all ten workflows to look up one name would
 * turn an unrelated construct in an unrelated workflow — `auto-release.yml`
 * today, anything added tomorrow — into a policy failure with nothing wrong.
 * Job-name collision does not need a governed workflow to happen in, so the
 * lookup must not need one either.
 */
function jobKeysOf(world, file) {
  const doc = world.docs.get(file);
  if (doc) return Object.keys(doc.jobs ?? {});
  const text = world.texts.get(file);
  if (text === undefined) return [];
  const keys = [];
  let indent = null;
  let inJobs = false;
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    if (/^jobs:\s*$/.test(line)) { inJobs = true; continue; }
    if (!inJobs) continue;
    if (/^\S/.test(line)) break; // the next top-level key ends the jobs mapping
    const match = /^(\s+)([A-Za-z0-9_][\w.-]*):/.exec(line);
    if (!match) continue;
    if (indent === null) indent = match[1].length;
    if (match[1].length === indent) keys.push(match[2]);
  }
  return keys;
}

/**
 * The run lines of a job that are actual work.
 *
 * A placeholder job is syntactically a job: it has a runner, a timeout and a
 * step. What it does not have is a command, and `echo`/`true`/`exit 0` is how
 * one is written. Everything else counts, so this cannot be satisfied by
 * commenting the real command out either.
 */
function realRunLines(job) {
  return (job?.steps ?? [])
    .flatMap((step) => String(step?.run ?? "").split("\n"))
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"))
    .filter((line) => !/^(echo\b|printf\b|true$|:$|exit 0$|set\s+-|shopt\b)/.test(line));
}

/**
 * Every platform-boundary complaint about one world, as messages.
 *
 * Returning rather than pushing is the whole design: the real world's messages
 * are appended to `failures`, and section 8 asserts that specific mutations
 * produce specific messages.
 */
function platformBoundaryFailures(world) {
  const out = [];
  const need = (ok, message) => { if (!ok) out.push(message); };

  const governedFiles = world.governed.map((entry) => entry.file);
  const filtered = governedFiles.filter((file) => wPaths(world, file) !== null);
  const allPlatforms = [...PLATFORM_OWNERS, ...FUTURE_PLATFORMS];

  // 6a. One platform root, one heavy owner — asserted from the build command
  //     rather than from a job name, and from the FILTER rather than from the
  //     path list, so "too broad" and "too narrow" both fail here.
  for (const platform of PLATFORM_OWNERS) {
    const hosts = governedFiles.filter((file) => wJobBody(world, file).includes(platform.marker));
    const wantedHosts = platform.buildHosts ?? [platform.workflow];
    need(
      deepEqual(hosts.sort(), wantedHosts.toSorted()),
      `platform root ${platform.root}: the ${platform.label} app build (\`${platform.marker}\`) `
      + `runs in [${hosts.join(", ")}]; want exactly [${wantedHosts.join(", ")}]. The platform has `
      + `one build owner plus only its declared acceptance hosts; any other host adds a runner `
      + `with no new evidence, while zero leaves the platform unbuilt.`,
    );
    need(
      wTriggers(world, platform.workflow, platform.sample),
      `platform root ${platform.root}: its owning workflow ${platform.workflow} does not trigger `
      + `on "${platform.sample}". An owner its own root cannot start is not an owner, and the `
      + `platform lands unbuilt with a green board.`,
    );
    for (const other of allPlatforms) {
      if (other.root === platform.root) continue;
      if (!world.docs.has(other.workflow)) continue;
      need(
        !wTriggers(world, other.workflow, platform.sample),
        `platform root ${platform.root} also starts ${other.workflow}, which owns ${other.root}. `
        + `Platform roots do not fan out: a change under ${platform.root} must not start another `
        + `platform's heavy build. This is exactly what a coarse \`apps/**\` filter does, and it `
        + `is what the macOS/iOS split was for.`,
      );
    }
  }

  // 6b. No governed filter may be coarse enough to adopt a root by accident —
  //     stated twice, once as the literal glob a reader greps for and once as
  //     behaviour, because a future `apps/*/**` would pass the literal check.
  for (const file of filtered) {
    const paths = wPaths(world, file);
    for (const bare of ["apps/**", "apps/*", "apps/*/**", "scripts/**", "scripts/*"]) {
      need(
        !paths.includes(bare),
        `${file}'s path filter lists the bare glob \`${bare}\`. It matches trees that are not `
        + `inputs to this workflow today AND every tree somebody adds tomorrow, so the next `
        + `platform root or platform script inherits this runner without anybody choosing that. `
        + `Name the files and directories this workflow actually consumes.`,
      );
    }
    const spanned = allPlatforms.filter((p) => matchesFilter(paths, p.sample)).map((p) => p.root);
    if (file === SWIFT_PACKAGE_LANE) {
      // The ONE exception, and it is exact rather than permissive.
      //
      // The rule below protects a workflow that BUILDS a platform: it must be
      // startable for that platform alone. The package lane builds neither app.
      // It runs one suite whose guard cases READ both Apple app trees — project
      // files, plists, entitlements, privacy manifests, `.strings` catalogs —
      // and the same run answers for both, so there is nothing to start "for one
      // of them alone". Before it watched these roots an `apps/mac`-only change
      // ran none of those guards (`macos.yml` runs no `swift test`) and an
      // `apps/ios`-only change ran a hand-kept list of ten selectors out of the
      // thirty-odd files that read that tree.
      //
      // Exact, because the exception is for the two trees this suite reads and
      // for no other: Android and Windows have their own suites in their own
      // lanes, and a third root here would be the whole Swift suite on a macOS
      // runner for a tree no Swift test opens.
      need(
        deepEqual([...spanned].sort(), [...SWIFT_PACKAGE_READ_ROOTS].sort()),
        `${file}'s path filter matches platform roots [${spanned.join(", ")}]; want exactly `
        + `[${SWIFT_PACKAGE_READ_ROOTS.join(", ")}]. This lane is the single exception to "one `
        + `workflow, at most one platform root" because it builds no platform and its guard tests `
        + `read exactly these two trees. Fewer is a platform whose guards run on no change to it `
        + `— ${MACOS} runs no \`swift test\` — and more is the whole package suite on a PAID macOS `
        + `runner for a tree no Swift test opens.`,
      );
      continue;
    }
    need(
      spanned.length <= 1,
      `${file}'s path filter matches more than one platform root (${spanned.join(", ")}). One `
      + `workflow that starts on two platforms' source cannot be started for one of them alone, `
      + `no matter how its jobs are conditioned — path filters are per-workflow. The only `
      + `exception is ${SWIFT_PACKAGE_LANE}, which builds no platform.`,
    );
  }

  // 6c. The Apple-shared package: exactly two owners, and not one more.
  const appleOwners = PLATFORM_OWNERS
    .filter((platform) => wTriggers(world, platform.workflow, SHARED_APPLE_SAMPLE))
    .map((platform) => platform.workflow)
    .sort();
  need(
    deepEqual(appleOwners, [IOS, MACOS].sort()),
    `the Apple-shared package ${SHARED_APPLE_ROOT} fans out to [${appleOwners.join(", ")}]; want `
    + `exactly [${[IOS, MACOS].sort().join(", ")}]. Both native apps compile against it, so a `
    + `change there can break either one alone; dropping it from one filter leaves that app's `
    + `compatibility with the shared package unproven until something else happens to touch it.`,
  );
  for (const platform of PLATFORM_OWNERS.filter((p) => p.appleShared)) {
    const paths = wPaths(world, platform.workflow);
    if (paths === null) continue;
    need(
      paths.includes(`${SHARED_APPLE_ROOT}/**`),
      `${platform.workflow}'s path filter no longer names \`${SHARED_APPLE_ROOT}/**\`. Stated `
      + `separately from the fan-out check above so the reason survives a filter that happens to `
      + `match the shared package through some broader glob.`,
    );
  }
  // The same boundary for every platform that does NOT compile the package —
  // owners that are not Apple (Android today) and futures alike. One loop over
  // both, because the rule is about the package, not about how mature the
  // platform is.
  for (const platform of [
    ...PLATFORM_OWNERS.filter((p) => !p.appleShared),
    ...FUTURE_PLATFORMS,
  ]) {
    if (!world.docs.has(platform.workflow)) continue;
    need(
      !wTriggers(world, platform.workflow, SHARED_APPLE_SAMPLE),
      `${platform.workflow} triggers on ${SHARED_APPLE_ROOT}. That package is APPLE-SHARED, not `
      + `cross-platform: it is Swift, it links WebRTC and Sodium through SwiftPM, and nothing `
      + `outside macOS and iOS compiles it. A ${platform.label} workflow watching it burns a `
      + `runner on every Apple change and proves nothing. Truly cross-platform contracts belong `
      + `in ${COMPAT}.`,
    );
  }

  // 6d. The pairing acceptance is a macOS+browser gate, not an iOS one — and
  //     narrowing it past its OWN inputs is asserted in the same place, because
  //     that is the failure a "make the filter smaller" edit actually causes.
  if (world.docs.has(NWP)) {
    const ios = PLATFORM_OWNERS.find((platform) => platform.root === "apps/ios");
    need(
      !wTriggers(world, NWP, ios.sample),
      `${NWP} triggers on ${ios.root}. Its acceptance compiles ${SHARED_APPLE_ROOT} and the Web `
      + `bundle and drives a macOS peer against a real Chrome; no file under ${ios.root} is an `
      + `input to it. An iOS-only change would start a 45-minute macOS runner that builds nothing `
      + `it touched.`,
    );
    // The INPUTS, each of which the run actually reads, compiles or serves.
    // Every entry here was checked against the script rather than against the
    // workflow's own prose: `scripts/native-web-pairing-acceptance.sh` builds
    // `server` and `apps/RelayiumKit` (`swift build --product
    // LocalTransferPeer`) and `vite build`s `web/`, and sources exactly one
    // library. Nothing else is loaded.
    for (const [input, why] of [
      [SHARED_APPLE_SAMPLE, "the Swift half it actually compiles"],
      ["web/src/lib/pair.ts", "the browser half's own pairing code"],
      ["server/account/pairroom.go", "the real hub the two clients meet on"],
      ["scripts/native-web-pairing-acceptance.sh", "the acceptance script itself"],
      ["scripts/lib/local-acceptance.sh", "the isolation library that script sources"],
    ]) {
      need(
        wTriggers(world, NWP, input),
        `${NWP} no longer triggers on "${input}" — ${why}. Narrowing a filter past the run's own `
        + `inputs disables the gate as effectively as deleting the step, and is cheaper to do by `
        + `accident.`,
      );
    }
    // And the tree that is NOT an input, stated in the same place, because the
    // two errors are one decision made in opposite directions and a file that
    // only asserted the narrowing would invite the widening.
    //
    // `apps/mac/**` is what this acceptance SPEAKS FOR and is still not what it
    // reads: the app target is SwiftUI views over `RelayiumAppKit`, which lives
    // under `apps/RelayiumKit/**` and IS watched above. An apps/mac-only change
    // must therefore start `macos.yml` — plus the two unfiltered always-on
    // workflows — and no 45-minute macOS pairing runner.
    const mac = PLATFORM_OWNERS.find((platform) => platform.root === "apps/mac");
    need(
      !wTriggers(world, NWP, mac.sample),
      `${NWP} triggers on ${mac.root} ("${mac.sample}"), which is not an input to it. The `
      + `acceptance builds \`server\` and ${SHARED_APPLE_ROOT} and serves the Web bundle; no file `
      + `under ${mac.root} is read, compiled or served by the run, so this filter charges a `
      + `45-minute macOS runner per commit for evidence it cannot produce. The macOS app's own `
      + `logic is in ${SHARED_APPLE_ROOT}, which this filter already names.`,
    );
  }

  // 6e. Absence or completeness, for the roots that do not exist yet.
  const known = new Set([
    ...PLATFORM_OWNERS.map((platform) => platform.root),
    ...FUTURE_PLATFORMS.map((future) => future.root),
    SHARED_APPLE_ROOT,
  ]);
  for (const root of [...world.roots].sort()) {
    need(
      known.has(root),
      `unknown platform root "${root}" exists under apps/. Every root is either a platform with `
      + `exactly one owning workflow or the Apple-shared package; a root this policy has never `
      + `heard of is source with no declared owner, no declared filter and no declared release `
      + `pipeline. Add it to PLATFORM_OWNERS or FUTURE_PLATFORMS in the same commit that creates `
      + `it, together with the workflow that builds it.`,
    );
  }
  for (const future of FUTURE_PLATFORMS) {
    const rootExists = world.roots.has(future.root);
    const workflowExists = world.texts.has(future.workflow);

    need(
      !(rootExists && !workflowExists),
      `${future.root}/ exists but .github/workflows/${future.workflow} does not. A platform root `
      + `and the workflow that owns it are created in the SAME commit: until then nothing `
      + `compiles, tests or signs that source, and the board is green only because nobody asked.`,
    );
    need(
      !(workflowExists && !rootExists),
      `.github/workflows/${future.workflow} exists but ${future.root}/ does not. A platform `
      + `workflow with no real source is a placeholder — it reports a green ${future.label} check `
      + `for a platform that does not exist, which is worse than an absent check because it looks `
      + `like coverage.`,
    );
    if (!rootExists || !workflowExists) continue;

    need(
      world.governed.some((entry) => entry.file === future.workflow),
      `${future.workflow} exists but is not in this test's GOVERNED list, so the push/pull_request `
      + `and concurrency policy above does not bind it — it may run twice per commit, or cancel a `
      + `\`main\` run, and nothing would say so. Add it there in the same commit.`,
    );
    const doc = world.docs.get(future.workflow);
    if (!doc) {
      need(false, `${future.workflow} exists but was not parsed, so nothing below judged it.`);
      continue;
    }
    need(
      wTriggers(world, future.workflow, future.sample),
      `${future.workflow} does not trigger on its own root ${future.root} (tried `
      + `"${future.sample}"). A platform workflow pointed at the wrong root is a check that never `
      + `runs, and its platform ships unbuilt behind a green board.`,
    );
    for (const other of allPlatforms) {
      if (other.root === future.root) continue;
      need(
        !wTriggers(world, future.workflow, other.sample),
        `${future.workflow} also triggers on ${other.root}, which it does not build.`,
      );
    }
    const jobs = Object.entries(doc.jobs ?? {});
    const buildJobs = jobs.filter(
      ([, job]) => future.build.test(runText(job)) && realRunLines(job).length > 0,
    );
    need(
      buildJobs.length >= 1,
      `${future.workflow} has no job that actually builds or tests ${future.root}: no run step `
      + `matching ${future.build} whose command is more than an \`echo\`. A workflow that only `
      + `echoes reports a green ${future.label} check for source nobody compiled.`,
    );
    for (const [name, job] of jobs) {
      const timeout = Number(job["timeout-minutes"]);
      need(
        Number.isFinite(timeout) && timeout > 0,
        `${future.workflow}/${name}: timeout-minutes is `
        + `${JSON.stringify(job["timeout-minutes"])}, want a finite positive number.`,
      );
      need(
        job["continue-on-error"] === undefined,
        `${future.workflow}/${name}: continue-on-error makes this platform's gate advisory.`,
      );
      need(
        !/retry|retries/i.test(runText(job)),
        `${future.workflow}/${name}: a retry appeared; a platform build that is re-rolled until it `
        + `passes reports the run that agreed rather than the code.`,
      );
    }
  }

  // 6f. The always-on compatibility gate: unfiltered, cheap, fail-closed, finite.
  //
  //     All four are properties of the workflow FILE, which is the only thing
  //     this test can read. They make the gate always-RUN — it starts on every
  //     triggering event and reports red when the contract breaks. They do not
  //     make a red result BLOCK a merge: that is branch protection on `main`,
  //     the status context `compat / wire-vectors`, and it lives in repository
  //     settings rather than in this repository's source. Nothing below is
  //     evidence that it is configured, and no message here should be read as
  //     claiming it is. The one half of that context this file CAN check is its
  //     job name, and section 6j does.
  need(
    world.texts.has(COMPAT),
    `${COMPAT} is missing. It is the always-required wire-compatibility gate — the one check `
    + `every platform, present and future, has to pass — and nothing else in this repository runs `
    + `\`${VECTOR_COMMAND}\`.`,
  );
  const compat = world.docs.get(COMPAT);
  if (compat) {
    need(
      wPaths(world, COMPAT) === null,
      `${COMPAT} gained a push path filter (${JSON.stringify(wPaths(world, COMPAT))}). It must `
      + `have none: a filter is precisely how a new platform root — or a tree somebody narrowed — `
      + `stops being covered by the cross-language contract without anybody deciding to exempt it. `
      + `Always-required means always-run.`,
    );
    // There is no `pull_request` filter left to check here. This file's direct
    // pull-request trigger is gone — section 1 fails by name if it returns —
    // and a pull request now reaches the gate only through `merge-gate.yml`,
    // which is itself unfiltered and calls this lane with no `if:`. The
    // unfiltered-ness that matters is therefore the `push` filter asserted
    // above plus the aggregate's own shape, which section 6n owns.
    const jobs = Object.entries(compat.jobs ?? {});
    need(jobs.length >= 1, `${COMPAT} has no jobs, so the always-on gate checks nothing.`);
    for (const [name, job] of jobs) {
      need(
        job["runs-on"] === "ubuntu-latest",
        `${COMPAT}/${name} runs on ${JSON.stringify(job["runs-on"])}; the always-on gate must stay `
        + `on the cheapest hosted runner. A macOS or Windows runner here turns a seconds-long `
        + `contract check into a platform build charged on every single commit, and the first `
        + `response to that bill is to add the path filter the check must not have.`,
      );
      const timeout = Number(job["timeout-minutes"]);
      need(
        Number.isFinite(timeout) && timeout > 0,
        `${COMPAT}/${name}: timeout-minutes is ${JSON.stringify(job["timeout-minutes"])}, want a `
        + `finite positive number. An unbounded always-on job holds a runner for GitHub's 6-hour `
        + `default on every commit.`,
      );
      need(
        job["continue-on-error"] === undefined,
        `${COMPAT}/${name}: continue-on-error makes the compatibility gate advisory, and an `
        + `advisory contract check is indistinguishable from no contract check.`,
      );
      need(
        job.if === undefined,
        `${COMPAT}/${name}: a job-level "if:" lets the always-on gate skip itself. It reads no `
        + `secrets and must run on every triggering event, fork pull requests included.`,
      );
      const text = runText(job);
      need(
        !/retry|retries/i.test(text),
        `${COMPAT}/${name}: a retry appeared. This gate compares frozen bytes against their `
        + `generator; there is nothing intermittent for a retry to smooth over, so a retry here `
        + `only hides a real divergence.`,
      );
      need(
        !/\|\|\s*(true|:|echo|exit 0)/.test(text),
        `${COMPAT}/${name}: a command swallows its own exit status, so the gate reports green `
        + `after failing.`,
      );
      need(
        realRunLines(job).length > 0,
        `${COMPAT}/${name}: has no real run step — every run line is an \`echo\` or a no-op. A `
        + `placeholder job reports a green compatibility check for a contract nobody verified.`,
      );
      for (const step of job.steps ?? []) {
        need(
          step["continue-on-error"] === undefined,
          `${COMPAT}/${name}: a step sets continue-on-error, which lets the gate report green `
          + `after failing.`,
        );
        need(
          step.if === undefined,
          `${COMPAT}/${name}: a step sets "if:", and a gate that can skip itself is not a gate.`,
        );
      }
    }
  }

  // 6g. And the command itself: once, in the right place, in the verifying
  //     form — plus the dependency closure it cannot run without.
  //
  //     The install half was added after `gen-crypto-vectors.mjs` joined the
  //     gate's table in `5619f062`. That generator imports `libsodium-wrappers`,
  //     a PRODUCTION dependency rather than a `node:` builtin, so from that
  //     commit on a job with no dependency tree could not run this gate at all.
  //     It passed review because a developer checkout already had
  //     `web/node_modules` sitting there; a clean runner — which is every
  //     runner — got ERR_MODULE_NOT_FOUND. That is the worst shape a required
  //     gate can fail in: red for a reason unrelated to the contract it exists
  //     to check, which is the shortest path to somebody making it advisory.
  //
  //     So the install is asserted as strictly as the command: present, BEFORE
  //     the command, in the same declared working directory, in the
  //     lockfile-respecting form, and carrying each flag that keeps it minimal.
  //     Its fail-closed properties are not re-checked here — 6f already bans a
  //     step-level `if:`, a step-level `continue-on-error:` and a swallowed exit
  //     status across every step of this job, install included.
  const compatDoc = world.docs.get(COMPAT);
  for (const [jobName, job] of Object.entries(compatDoc?.jobs ?? {})) {
    const steps = job?.steps ?? [];
    const runOf = (step) => String(step?.run ?? "");
    const gateAt = steps.findIndex((step) => runOf(step).includes(VECTOR_COMMAND));
    // No gate command in this job is a different defect, and the host check
    // below is what reports it. Nothing here would be meaningful.
    if (gateAt === -1) continue;

    const installAt = steps.findIndex((step) => ANY_NPM_INSTALL.test(runOf(step)));
    need(
      installAt !== -1,
      `${COMPAT}/${jobName} runs \`${VECTOR_COMMAND}\` with no dependency install before it. The `
      + `gate's own generators import \`libsodium-wrappers\`, a production dependency, so on a `
      + `clean runner this job dies with ERR_MODULE_NOT_FOUND before it compares a single byte. It `
      + `only appears to work on a machine that already has a stale \`web/node_modules\`.`,
    );
    if (installAt === -1) continue;

    const installRun = runOf(steps[installAt]).trim();
    need(
      VECTOR_INSTALL.test(installRun),
      `${COMPAT}/${jobName}: the dependency install is \`${installRun}\`, which is not \`npm ci\`. `
      + `\`npm install\` may resolve a version \`package-lock.json\` does not name and may rewrite `
      + `the lockfile in place, so the bytes this gate compares would depend on the day it ran. A `
      + `gate that compares frozen bytes is installed from frozen bytes.`,
    );
    need(
      installAt < gateAt,
      `${COMPAT}/${jobName} installs its dependencies AFTER the gate command (install at step `
      + `${installAt + 1}, \`${VECTOR_COMMAND}\` at step ${gateAt + 1}). The generators resolve `
      + `their imports the moment they start; an install that follows them runs too late to be the `
      + `reason they worked.`,
    );
    for (const { flag, why } of VECTOR_INSTALL_FLAGS) {
      need(
        installRun.includes(flag),
        `${COMPAT}/${jobName}: the dependency install dropped \`${flag}\` (\`${installRun}\`). `
        + `It is not decoration — ${why}.`,
      );
    }
    for (const [label, index] of [["dependency install", installAt], ["gate command", gateAt]]) {
      need(
        steps[index]["working-directory"] === VECTOR_WORKDIR,
        `${COMPAT}/${jobName}: the ${label} declares working-directory `
        + `${JSON.stringify(steps[index]["working-directory"])}, want `
        + `${JSON.stringify(VECTOR_WORKDIR)}. Both halves must run in the tree that holds `
        + `\`package.json\`, \`package-lock.json\` and the generators; an install that lands `
        + `somewhere else succeeds loudly and leaves the gate's \`node_modules\` missing.`,
      );
    }
  }

  const vectorHosts = [...world.texts]
    .filter(([, text]) => text.includes(VECTOR_COMMAND))
    .map(([file]) => file)
    .sort();
  need(
    deepEqual(vectorHosts, [COMPAT]),
    `\`${VECTOR_COMMAND}\` runs in [${vectorHosts.join(", ")}]; want exactly [${COMPAT}]. Zero `
    + `hosts is the cross-language wire contract silently unchecked — every Swift vector suite `
    + `would keep passing against the OLD wire. Two hosts is the same seconds-long check paid for `
    + `twice, and historically one of them sat behind a path filter a new platform could bypass.`,
  );
  const writers = [...world.texts]
    .filter(([, text]) => text.includes(VECTOR_WRITER))
    .map(([file]) => file)
    .sort();
  need(
    writers.length === 0,
    `[${writers.join(", ")}] run the WRITING form of the vector generator (\`${VECTOR_WRITER}\`). `
    + `CI must verify the tracked bytes, never regenerate them — a gate that rewrites the fixture `
    + `it is checking agrees with whatever it just produced.`,
  );

  // 6h. And the one property none of the above can establish about itself:
  //     that something actually RUNS this file, on everything, fail-closed.
  //
  //     Every assertion in sections 5–7 is worth exactly what its execution is
  //     worth. Delete the step that invokes it and all of them go quiet: no
  //     YAML breaks, actionlint is happy, the board is green, and the next
  //     signal is a coarse filter charging a macOS runner on a documentation
  //     edit — or a platform root that never got built. The same is true of the
  //     cheaper edits: a job-level `if:`, a `continue-on-error:`, or a `|| true`
  //     on the command each leave the invocation visibly present and its verdict
  //     unable to stop anything.
  //
  //     It must be the UNFILTERED host, too. Behind a path filter this policy
  //     would run only when the trees that filter happens to name change, which
  //     is the exact defect section 6f exists to reject one level down: a check
  //     every change must pass, reachable only by some changes.
  //
  //     And the invocation must be BOUNDED by a number somebody chose. A job
  //     with no `timeout-minutes` inherits GitHub's six-hour default, so this
  //     policy hanging — a parser loop on a malformed document, a runner that
  //     never finishes booting — holds a runner for six hours on every commit
  //     instead of turning the board red in minutes. A declared bound far above
  //     what the work takes is the same default wearing a number, so the
  //     ceiling is asserted in both directions.
  const selfHostDoc = world.docs.get(SELF_HOST);
  need(
    selfHostDoc !== undefined,
    `${SELF_HOST} is missing, and it is what runs \`${SELF_COMMAND}\` on every pull request and `
    + `every \`main\` push. Without it nothing in this file is executed and every assertion above `
    + `is inert.`,
  );
  if (selfHostDoc) {
    need(
      wPaths(world, SELF_HOST) === null,
      `${SELF_HOST} gained a push path filter (${JSON.stringify(wPaths(world, SELF_HOST))}). It `
      + `hosts this policy, which judges .github/workflows/ and apps/ as a whole, so a filter `
      + `means the boundary is only checked when the trees that filter happens to name change — `
      + `the same exemption-by-omission section 6f rejects for ${COMPAT}.`,
    );
    const selfPr = selfHostDoc.on?.pull_request;
    need(
      !(selfPr && typeof selfPr === "object" && selfPr.paths),
      `${SELF_HOST} gained a pull_request path filter, so branch work can reach \`main\` without `
      + `this policy having run on it.`,
    );

    // Found by the COMMAND, so renaming the job is allowed and losing its
    // invocation is not.
    const hosts = Object.entries(selfHostDoc.jobs ?? {})
      .filter(([, job]) => realRunLines(job).some((line) => line.includes(SELF_COMMAND)));
    need(
      hosts.length === 1,
      `${hosts.length} job(s) in ${SELF_HOST} run \`${SELF_COMMAND}\`; want exactly one. Zero is `
      + `this entire policy file present in the repository and executed by nothing — the most `
      + `expensive kind of green, because the assertions still read as coverage. Two is the same `
      + `seconds-long check charged twice.`,
    );
    for (const [name, job] of hosts) {
      need(
        job.if === undefined,
        `${SELF_HOST}/${name}: a job-level "if:" lets the job that runs \`${SELF_COMMAND}\` skip `
        + `itself. This policy reads no secrets and must run on every triggering event, fork pull `
        + `requests included.`,
      );
      need(
        job["continue-on-error"] === undefined,
        `${SELF_HOST}/${name}: continue-on-error makes this policy advisory. An advisory boundary `
        + `check reports the same green as a passing one and stops nothing.`,
      );
      const timeout = Number(job["timeout-minutes"]);
      need(
        Number.isFinite(timeout) && timeout > 0,
        `${SELF_HOST}/${name}: timeout-minutes is ${JSON.stringify(job["timeout-minutes"])}, want `
        + `a finite positive number. Undeclared, this job inherits GitHub's 6-hour default, so a `
        + `hang in the policy that gates every commit holds a runner for six hours instead of `
        + `reporting red in minutes.`,
      );
      need(
        !(Number.isFinite(timeout) && timeout > SELF_TIMEOUT_MAX),
        `${SELF_HOST}/${name}: timeout-minutes is ${JSON.stringify(job["timeout-minutes"])}, above `
        + `the ${SELF_TIMEOUT_MAX}-minute ceiling. This policy parses a few small YAML documents `
        + `and finishes in seconds; a bound that large is the 6-hour default wearing a number, and `
        + `it buys nothing that a real hang would not spend.`,
      );
      for (const step of job.steps ?? []) {
        need(
          step["continue-on-error"] === undefined,
          `${SELF_HOST}/${name}: a step sets continue-on-error, which lets the job report green `
          + `after this policy failed.`,
        );
        need(
          step.if === undefined,
          `${SELF_HOST}/${name}: a step sets "if:", and a policy that can skip itself is not a `
          + `policy.`,
        );
      }
      const selfLine = realRunLines(job).find((line) => line.includes(SELF_COMMAND));
      need(
        !/\|\|\s*(true|:|echo|exit 0)/.test(selfLine ?? ""),
        `${SELF_HOST}/${name}: the \`${SELF_COMMAND}\` command swallows its own exit status `
        + `("${(selfLine ?? "").trim()}"), so every failure above is reported as a pass.`,
      );
    }
  }

  // 6i. The paid-runner budget, and the absence of commit-message escapes.
  //
  //     Two properties of the most expensive lanes in this repository. Neither
  //     is visible to YAML validity or to actionlint, neither is covered by
  //     anything above, and both were live defects until they were fixed.
  //
  //     TIMEOUTS. A job with no `timeout-minutes` inherits GitHub's SIX-HOUR
  //     default. `ios.yml`, `release.yml` and five of the six jobs `macos.yml`
  //     carried at the time had none. On `ios.yml` that is a paid macOS runner
  //     held for six hours by a simulator that never booted; on `release.yml` it
  //     is a wedged release job sitting for six hours with the signing key
  //     materialized on disk; across the macOS lanes it was every job that
  //     imports the Developer ID certificate, submits to Apple's notary, or
  //     publishes an immutable GitHub Release — the certificate-importing ones
  //     are `macos.yml`'s CI jobs, and the notarizing and publishing ones have
  //     since moved to `macos-release.yml`, where they are budgeted. The
  //     ceiling is asserted in the other direction too, exactly as in 6h: a
  //     bound declared far above what the work takes is the six-hour default
  //     wearing a number.
  //
  //     PER JOB, NOT PER FILE. Both macOS lanes are budgeted job by job because
  //     their jobs are not comparable: in `macos.yml`, `contract` is measured in
  //     seconds while `signed-build` pays a cold signed build; in
  //     `macos-release.yml`, `publish` is a free Linux runner while
  //     `notarize-stage` legitimately waits out Apple's 45-minute notary
  //     timeout. A single file-wide ceiling would have to be the largest of
  //     them, so it would pass a `contract` job wedged for an hour — the exact
  //     shape of "fix the slow job by raising the global timeout". The per-job
  //     form is enforced for completeness in BOTH directions, because a list
  //     that silently stops covering a job is indistinguishable from no list.
  //
  //     MATRIX BOUNDS. `ui-smoke` declares `timeout-minutes: ${{ matrix.timeout
  //     }}` and carries a real per-shard bound in each `include` entry. Those
  //     entries are what is checked; reading the unresolved expression as a
  //     number would call the shard bounds invalid and push the next editor
  //     toward replacing them with one flat number.
  //
  //     ESCAPES. `ios.yml` honoured a `[macos-only]` marker in a `main` commit
  //     message, which let a commit message skip the iOS build. A skipped check
  //     does not report red — it reports NOTHING — so the skip was invisible in
  //     the merge box, it applied on `main` after review where this workflow is
  //     the only thing that compiles iOS at all, and it was reachable by exactly
  //     the commit least likely to deserve it. The removal is asserted rather
  //     than remembered, in three independent ways: the literal marker must not
  //     reappear in either file; no job- or step-level condition may read a
  //     commit message, whatever marker it names; and `ios.yml` must carry no
  //     job-level `if:` at all.
  //
  //     The marker check reads the COMMENT-STRIPPED text, so both files may
  //     still explain in prose what was removed and why — which they do. That
  //     text comes from `world.texts`, which is loaded from every workflow file
  //     on disk and therefore covers `release.yml` even though it is parsed for
  //     its budget only and is deliberately absent from `GOVERNED`. Its presence
  //     is ASSERTED rather than assumed: a budget file whose text never reached
  //     the world would make the marker check inspect the empty string and pass,
  //     which is the same silent non-assertion section 8 exists to prevent.
  for (const budget of RUNNER_BUDGETS) {
    const doc = world.docs.get(budget.file);
    need(
      doc !== undefined,
      `${budget.file} is missing or did not parse, so its runner budget and its escape hatches `
      + `are unchecked. It is named in this policy on purpose: dropping it from the list is how `
      + `an expensive lane stops being bounded without anybody deciding to unbound it.`,
    );
    if (!doc) continue;

    const jobs = Object.entries(doc.jobs ?? {});
    need(
      jobs.length >= 1,
      `${budget.file} parsed with no jobs, so every per-job assertion below would pass by `
      + `inspecting nothing.`,
    );

    for (const [name, job] of jobs) {
      // Checked before the caller exemption below, so a reusable-caller job is
      // still bound by it. A caller carries no bound of its own, but it does
      // carry an `if:` — and a commit-message escape there would skip the whole
      // called workflow, which is every gate at once.
      for (const condition of [job.if, ...(job.steps ?? []).map((step) => step?.if)]) {
        if (typeof condition !== "string") continue;
        need(
          !COMMIT_MESSAGE_CONDITION.test(condition),
          `${budget.file}/${name}: a condition reads the commit message (${JSON.stringify(condition)}). `
          + `Whatever marker it names, that is the \`${SKIP_MARKER}\` escape returning in a new `
          + `spelling: it hands the decision about whether this gate runs to whoever writes the `
          + `commit, and a skipped check reports nothing rather than red.`,
        );
      }

      const perJob = budget.jobs?.[name];
      // A job that CALLS a reusable workflow is bounded by exemption, not by a
      // number. GitHub rejects a workflow outright when a `uses:` job declares
      // `timeout-minutes`, so the ordinary rule below — a finite positive bound
      // under a ceiling — cannot be satisfied by one and would push whoever hit
      // it toward inlining the called workflow back into this file, which is the
      // split this policy exists to hold.
      //
      // The exemption is not a hole: the caller starts no runner of its own, and
      // every job it does start carries its own bound inside the callee, where
      // this same section budgets it job by job. Both halves are asserted — the
      // policy must DECLARE the exemption (`caller: true`), and the job must
      // carry no bound.
      const isCaller = typeof job.uses === "string" && job.uses !== "";
      need(
        !isCaller || perJob?.caller === true,
        `${budget.file}/${name} calls a reusable workflow (\`uses: ${job.uses}\`) but this policy `
        + `does not declare it a caller. A \`uses:\` job cannot carry \`timeout-minutes\`, so it `
        + `is budgeted by the callee's own per-job bounds instead; mark it \`caller: true\` and `
        + `make sure the workflow it calls is itself budgeted here. Silence would mean a job `
        + `nobody budgeted and nobody exempted.`,
      );
      need(
        !isCaller || job["timeout-minutes"] === undefined,
        `${budget.file}/${name} calls a reusable workflow AND declares \`timeout-minutes: `
        + `${JSON.stringify(job["timeout-minutes"])}\`. GitHub rejects the whole workflow for `
        + `that — the release lane would stop running entirely, which on a manual entry point is `
        + `discovered at the moment somebody needs to publish. Bound the callee's jobs instead.`,
      );
      need(
        !perJob?.caller || isCaller,
        `${budget.file}/${name} is declared a reusable caller in this policy but its job has no `
        + `\`uses:\`. An exemption pointed at a job that now runs its own steps is a PAID runner `
        + `with no bound and no ceiling, exempted by a line nobody re-read.`,
      );
      if (isCaller) continue;

      // Which ceiling applies to THIS job. A file declaring per-job budgets has
      // to name every job it declares: an unnamed one is not "unbounded by
      // decision", it is a job somebody added without deciding, and the
      // per-value checks below would then have no ceiling to compare against.
      need(
        budget.jobs === undefined || perJob !== undefined,
        `${budget.file}/${name}: this policy declares per-job runner budgets for ${budget.file} `
        + `and none for \`${name}\`, so its bound is whatever the file happens to say and nothing `
        + `checks it. It budgets [${Object.keys(budget.jobs ?? {}).join(", ")}]. Add \`${name}\` `
        + `with a ceiling justified by what it actually does — a new job on a PAID runner is `
        + `exactly the case this section exists for.`,
      );
      const max = perJob?.max ?? (budget.jobs === undefined ? budget.max : undefined);
      const why = perJob?.why ?? budget.why;
      // A floor is declared only where a bound BELOW the work is the expensive
      // mistake. It is asserted to be readable first: an unparsed floor is
      // `NaN`, every `value < NaN` is false, and the check would pass by
      // comparing against nothing.
      const min = perJob?.min;
      need(
        min === undefined || Number.isFinite(min),
        `${budget.file}/${name}: its runner-budget floor came out ${String(min)} rather `
        + `than a number, so nothing below it can be rejected. The floor is read from `
        + `${perJob?.minSource ?? "its declared source"}; if that moved or changed shape, the `
        + `floor has to follow it rather than quietly stop applying.`,
      );

      const resolved = timeoutValues(job);
      need(
        resolved.unresolved === undefined,
        `${budget.file}/${name}: timeout-minutes reads \`matrix.${resolved.unresolved}\`, but this `
        + `job declares no \`strategy.matrix.include\` entries to resolve it against, so it has no `
        + `readable bound at all. GitHub would substitute nothing and fall back to the 6-hour `
        + `default, so ${why}.`,
      );
      for (const { where, declared, value } of resolved.values ?? []) {
        need(
          Number.isFinite(value) && value > 0,
          `${budget.file}/${name}: ${where} is ${declared}, want a finite positive number. `
          + `Undeclared, this job inherits GitHub's 6-hour default, so ${why}.`,
        );
        need(
          max === undefined || !(Number.isFinite(value) && value > max),
          `${budget.file}/${name}: ${where} is ${declared}, above the ${max}-minute `
          + `ceiling. A bound that large is the 6-hour default wearing a number — it would not stop `
          + `the case it exists for, where ${why}.`,
        );
        need(
          !(Number.isFinite(min) && Number.isFinite(value) && value <= min),
          `${budget.file}/${name}: ${where} is ${declared}, at or below the ${min}-minute floor `
          + `set by ${perJob?.minSource}. ${perJob?.minWhy}.`,
        );
      }
    }

    // The other direction. A budget for a job that no longer exists enforces
    // nothing, and renaming a job is precisely how it stops being enforced
    // while the list still looks complete.
    for (const budgeted of Object.keys(budget.jobs ?? {})) {
      need(
        (doc.jobs ?? {})[budgeted] !== undefined,
        `${budget.file} declares no job named \`${budgeted}\`, but this policy carries a runner `
        + `budget for it; it declares [${jobs.map(([n]) => n).join(", ")}]. A budget naming a job `
        + `that is gone is a budget enforcing nothing, and the job it used to name has moved into `
        + `the unbudgeted case without anybody deciding that.`,
      );
    }

    const text = world.texts.get(budget.file);
    need(
      text !== undefined,
      `${budget.file} is parsed for its runner budget but its comment-stripped source never `
      + `reached this world, so the \`${SKIP_MARKER}\` marker check below would inspect nothing `
      + `and report a pass. The text and the parsed document have to arrive together.`,
    );
    need(
      !(text ?? "").includes(SKIP_MARKER),
      `${budget.file} contains the \`${SKIP_MARKER}\` commit-message marker again, outside a `
      + `whole-line comment. That escape let a commit message skip the iOS build; an escape hatch `
      + `in a gate is not a gate.`,
    );
  }

  //     And the general form, for the one file the escape actually lived in.
  //     A step-level `if:` is still fine — the failure-only diagnosis upload is
  //     one — because a step that runs only on failure cannot skip the build.
  const iosDoc = world.docs.get(IOS);
  if (iosDoc) {
    for (const [name, job] of Object.entries(iosDoc.jobs ?? {})) {
      need(
        job.if === undefined,
        `${IOS}/${name}: a job-level "if:" is back (${JSON.stringify(job.if)}). This job is the `
        + `only thing in this repository that compiles iOS; it reads no secrets, so it runs on `
        + `fork pull requests, and it must run on every event its path filter admits. A job-level `
        + `condition is exactly where the \`${SKIP_MARKER}\` escape lived.`,
      );
    }
  }

  // 6j. The job half of the required status context, and the collision the
  //     `app_id` binding cannot see.
  //
  //     `main`'s protection requires exactly one context, and since protection
  //     edit B that context is the aggregate's `merge-gate` job, bound to
  //     GitHub Actions `app_id` 15368.
  //
  //     `wire-vectors` is still the job name this section pins, and dropping
  //     compat's direct trigger did not change why. It is half of
  //     `compat / wire-vectors` — the check the aggregate consumes as its
  //     `compat` lane, and what the merge box renders from this workflow's
  //     `name:` and the job key joined — and it is the whole of the bare
  //     `wire-vectors` check run that `compat.yml`'s permanent `push: main`
  //     trigger puts on a `main` commit for `relayium-ops`' `deploy/promote.sh`
  //     to read before promoting.
  //
  //     The `app_id` binding answers exactly one threat: a DIFFERENTLY OWNED
  //     check — another GitHub App, or an external service posting a commit
  //     status — publishing the same context name and satisfying the requirement
  //     on behalf of a gate that never ran. It cannot answer the other one. A
  //     job key `wire-vectors` declared in a SECOND workflow in this repository
  //     is GitHub Actions, it is `app_id` 15368, and it produces a status with
  //     the same job name. Which run the merge box then reconciles the single
  //     requirement against is not a property this repository controls, so a
  //     green `wire-vectors` from some cheap unrelated lane can stand in for the
  //     cross-language contract gate — and it reports green, not missing.
  //
  //     Branch protection cannot prevent that; a settings read-back cannot
  //     detect it; and it leaves every workflow file syntactically valid. Only
  //     uniqueness of the name inside this repository prevents it, and that is
  //     checkable here, so it is checked here.
  //
  //     Both directions are asserted, because either alone would be vacuous.
  //     "No OTHER workflow declares it" passes trivially in a tree where
  //     `compat.yml` is gone or its job has been renamed — precisely the tree
  //     where the required context is satisfied by nothing at all. So the
  //     positive half comes first, and it fails loudly.
  //
  //     The scan covers EVERY workflow file on disk rather than the GOVERNED
  //     list: `release.yml`, `auto-release.yml` and anything added tomorrow can
  //     declare a job name just as well as a governed workflow can, and a rule
  //     that only inspected the governed set would miss the collision in the
  //     files least likely to be reviewed for it. See `jobKeysOf`.
  //
  //     This asserts the NAME, not the setting. It is not evidence that the
  //     context is required, and it does not license any change to branch
  //     protection or to a workflow's job names — renaming this job would
  //     silently un-require the gate, which is why the name is pinned here.
  const compatJobNames = jobKeysOf(world, COMPAT);
  need(
    compatJobNames.includes(COMPAT_JOB),
    `${COMPAT} declares no job named \`${COMPAT_JOB}\`; it declares `
    + `[${compatJobNames.join(", ")}]. That name is half of \`compat / ${COMPAT_JOB}\`, the `
    + `context ${AGGREGATE} consumes as its \`compat\` lane, and it is the whole of the bare `
    + `\`${COMPAT_JOB}\` check run that \`push: main\` puts on a \`main\` commit for `
    + `\`relayium-ops\`' \`deploy/promote.sh\` to read before promoting: rename or remove the `
    + `job and the aggregate judges a lane reporting nothing while production promotion wedges `
    + `on \`required check absent\`. It also makes the uniqueness check below vacuous — there is `
    + `nothing left for a second workflow to collide with.`,
  );
  const jobNameHosts = [...world.texts.keys()]
    .filter((file) => file !== COMPAT)
    .filter((file) => jobKeysOf(world, file).includes(COMPAT_JOB))
    .sort();
  need(
    jobNameHosts.length === 0,
    `[${jobNameHosts.join(", ")}] also declare a job named \`${COMPAT_JOB}\`, which is the job `
    + `half of \`compat / ${COMPAT_JOB}\` and, in its bare form, the check run production `
    + `promotion reads off a \`main\` commit. This is the `
    + `one substitution the \`app_id\` binding cannot stop: a second job of this name in this `
    + `repository is the SAME app, so its status carries the same context and the requirement can `
    + `be satisfied by a lane that never checked the wire contract. Give the job a different name `
    + `— only ${COMPAT} may declare \`${COMPAT_JOB}\`.`,
  );

  return out;
}


// ── 7. the fuzz campaign: scheduled, discovered, bounded, and never a gate ──
//
// Every `Fuzz…` target in `server/` is two things at once, and the difference
// is the whole of this section.
//
//   * As an ordinary test it runs its `f.Add` seeds and stops. That is
//     milliseconds, it is deterministic, and `go test ./...` in `go.yml`
//     already does it on every pull request. A crash the campaign once found
//     becomes a seed, and the seed is what keeps it from coming back.
//   * With `-fuzz` it GENERATES inputs until a clock runs out. That is timed,
//     non-deterministic, and worth ten minutes per target — on a schedule, not
//     in front of a merge.
//
// Both halves fail silently in opposite directions, and neither failure is
// visible to YAML validity or to actionlint:
//
//   * `-fuzz` added to a gating workflow adds its `-fuzztime` to every change
//     and makes a merge gate's verdict depend on the minute it ran. The
//     symptom is an intermittently red required check, and the first response
//     to that is always to make it advisory.
//   * The campaign given a hand-written target list keeps working forever after
//     it stops being complete: a target nobody adds to the list is never
//     fuzzed, every listed job is green, and the only signal is the crash that
//     campaign would have found. Same for a `pull_request:` trigger appearing
//     on it, for `fail-fast` reverting to its `true` default and cancelling
//     seven targets over one crash, for the crasher upload losing its
//     `if: failure()`, and for a budget going unbounded.
//
// So the campaign is asserted here as a shape: schedule and manual only, a
// discovery step that derives the matrix, one bounded command per target, and a
// crasher artifact retained finitely on failure. Written against a world like
// sections 5g and 6, so section 8 can break each rule and require the
// complaint.
//
// Deliberately NOT asserted, because this wave does not do them: a persisted or
// cached corpus, and any commit of generated inputs back to the repository.

/** Minutes, from a `10m` / `600s` style Go duration; NaN when unreadable. */
function goDurationMinutes(text) {
  const match = /^(\d+)(ms|m|s|h)$/.exec(text ?? "");
  if (!match) return NaN;
  const value = Number(match[1]);
  switch (match[2]) {
    case "h": return value * 60;
    case "m": return value;
    case "s": return value / 60;
    default: return value / 60000;
  }
}

/**
 * Every fuzz-campaign complaint about one world, as messages.
 *
 * Same contract as `platformBoundaryFailures`: it returns rather than pushes.
 */
function fuzzCampaignFailures(world) {
  const out = [];
  const need = (ok, message) => { if (!ok) out.push(message); };

  // 7a. No workflow that gates a change may generate inputs. This is the rule
  //     the whole split exists for, and it is checked over the GOVERNED set
  //     rather than over the campaign, because the regression is `-fuzz`
  //     appearing somewhere else.
  for (const file of world.governed.map((entry) => entry.file)) {
    for (const [name, job] of Object.entries(world.docs.get(file)?.jobs ?? {})) {
      need(
        !/\s-fuzz(time)?[\s=]/.test(runText(job)),
        `${file}/${name} runs a timed fuzz campaign (\`-fuzz\`). This workflow gates pull `
        + `requests: fuzzing here adds its whole \`-fuzztime\` to every change and makes the `
        + `gate's verdict depend on which inputs the fuzzer happened to generate that minute. `
        + `The seeds already run as ordinary tests; generation belongs in ${FUZZ_NIGHTLY}.`,
      );
    }
  }

  need(
    world.inventory,
    `${FUZZ_INVENTORY} is missing, and it is what tells the campaign which targets exist. `
    + `Without it ${FUZZ_NIGHTLY} still parses, still schedules and still declares a matrix — it `
    + `just discovers nothing, every night, and reports the failure of a step nobody reads.`,
  );

  const doc = world.docs.get(FUZZ_NIGHTLY);
  need(
    doc !== undefined,
    `${FUZZ_NIGHTLY} is missing or unparseable. It is the only place in this repository that `
    + `generates fuzz inputs; without it every \`Fuzz…\` target is a seed-corpus regression test `
    + `and nothing ever looks for a new crash.`,
  );
  if (!doc) return out;

  // 7b. Scheduled and manual, and nothing else. Stated as an exact key set:
  //     `push` and `pull_request` are the two that make it a gate, and a
  //     `pull_request_target` or a `workflow_run` would be a way for somebody
  //     else's commit to start ten minutes of compute per target.
  const on = doc.on ?? {};
  const triggers = Object.keys(on).sort();
  need(
    !("push" in on) && !("pull_request" in on),
    `${FUZZ_NIGHTLY} gained a \`push\` or \`pull_request\` trigger. That puts ten minutes per `
    + `target in front of every change and makes a merge gate non-deterministic — the exact `
    + `arrangement this workflow exists to keep out of the gating lanes.`,
  );
  need(
    deepEqual(triggers, ["schedule", "workflow_dispatch"]),
    `${FUZZ_NIGHTLY}'s triggers are [${triggers.join(", ")}]; want exactly `
    + `[schedule, workflow_dispatch]. A campaign is something somebody starts or something the `
    + `clock starts; any other event hands the decision to spend this compute to whoever can `
    + `cause that event.`,
  );

  // 7c. Read-only, and no secret in reach. It runs generated inputs through
  //     production parsing code; it must not be able to publish, deploy or
  //     authenticate as anything.
  need(
    deepEqual(doc.permissions, { contents: "read" }),
    `${FUZZ_NIGHTLY}'s permissions are ${JSON.stringify(doc.permissions)}, want `
    + `{"contents":"read"}. This workflow feeds generated bytes to production parsers; a write `
    + `token in that job is a write token reachable from whatever those bytes make the code do.`,
  );
  const jobs = Object.entries(doc.jobs ?? {});
  need(jobs.length >= 1, `${FUZZ_NIGHTLY} has no jobs, so the campaign fuzzes nothing.`);
  const wholeBody = JSON.stringify(doc.jobs ?? {});
  need(
    !/secrets\./.test(wholeBody),
    `${FUZZ_NIGHTLY} reads a \`secrets.\` value. Nothing here needs one: it checks out a public `
    + `tree, builds it and runs it against generated input.`,
  );

  // 7d. Bounded, non-advisory, non-retrying — for every job, so a future third
  //     job inherits the rule instead of escaping it.
  for (const [name, job] of jobs) {
    const timeout = Number(job["timeout-minutes"]);
    need(
      Number.isFinite(timeout) && timeout > 0,
      `${FUZZ_NIGHTLY}/${name}: timeout-minutes is ${JSON.stringify(job["timeout-minutes"])}, `
      + `want a finite positive number. Fuzzing is the one workload here that will genuinely run `
      + `forever if allowed to, so an unbounded job holds a runner for GitHub's six-hour default `
      + `every night.`,
    );
    need(
      job["continue-on-error"] === undefined,
      `${FUZZ_NIGHTLY}/${name}: continue-on-error makes the campaign advisory, so a reproducible `
      + `crash reports as a green night.`,
    );
    const text = runText(job);
    need(
      !/retry|retries/i.test(text),
      `${FUZZ_NIGHTLY}/${name}: a retry appeared. A fuzz failure is a saved, minimized input that `
      + `reproduces; re-rolling the search until it agrees discards the one artifact the run `
      + `exists to produce.`,
    );
    need(
      !/\|\|\s*(true|:|echo|exit 0)/.test(text),
      `${FUZZ_NIGHTLY}/${name}: a command swallows its own exit status, so a crash reports green.`,
    );
    for (const step of job.steps ?? []) {
      need(
        step["continue-on-error"] === undefined,
        `${FUZZ_NIGHTLY}/${name}: a step sets continue-on-error, which lets a crash report green.`,
      );
    }
  }

  // 7e. The target list is DISCOVERED. Two halves, and each is vacuous without
  //     the other: a discovery step whose output nothing consumes, and a matrix
  //     expression pointing at a job that discovers nothing.
  const discovery = jobs.filter(([, job]) => runText(job).includes(FUZZ_INVENTORY));
  need(
    discovery.length === 1,
    `${discovery.length} job(s) in ${FUZZ_NIGHTLY} run \`${FUZZ_INVENTORY}\`; want exactly one. `
    + `Zero is a hand-maintained target list, which is the failure this whole arrangement is `
    + `built to avoid: it keeps working after it stops being complete, and a target nobody `
    + `remembered to add is simply never fuzzed behind a green board.`,
  );
  const [discoveryName, discoveryJob] = discovery[0] ?? [];
  if (discoveryJob) {
    const text = runText(discoveryJob);
    need(
      /list-go-fuzz-targets\.sh\s+--json/.test(text),
      `${FUZZ_NIGHTLY}/${discoveryName} never asks \`${FUZZ_INVENTORY}\` for its \`--json\` form, `
      + `which is the only output shaped like a matrix. The human form would be consumed as one `
      + `opaque string and the matrix would have a single meaningless entry.`,
    );
    need(
      /GITHUB_OUTPUT/.test(text),
      `${FUZZ_NIGHTLY}/${discoveryName} does not write to \`$GITHUB_OUTPUT\`, so whatever it `
      + `discovered stays inside the step and the matrix below reads an empty value.`,
    );
    need(
      Object.keys(discoveryJob.outputs ?? {}).length > 0,
      `${FUZZ_NIGHTLY}/${discoveryName} declares no \`outputs:\`, so nothing it discovered leaves `
      + `the job — a step output is not a job output.`,
    );
    // Counted over the COMMANDS, not the comments: the sentences around this
    // step name the script repeatedly and on purpose, and none of them runs it.
    const invocations =
      (runText(withoutRunComments(discoveryJob)).match(/list-go-fuzz-targets\.sh/g) ?? []).length;
    need(
      invocations === 1,
      `${FUZZ_NIGHTLY}/${discoveryName} invokes \`${FUZZ_INVENTORY}\` ${invocations} times; want `
      + `exactly one. The script compiles every test binary in the module to list the targets `
      + `inside it, so a second call — the obvious one being a human-readable log line next to `
      + `the \`--json\` form the matrix needs — pays that whole cost twice. And it asks the `
      + `module twice: the list printed for a reader and the list the campaign fans out over `
      + `become two independent answers that are equal only by assumption, so a discrepancy `
      + `between them is invisible in exactly the log somebody would consult to find it. `
      + `Capture one invocation and echo what was captured.`,
    );
  }

  const campaigns = jobs.filter(([, job]) => /go test\b[^\n]*-fuzz\b/.test(runText(job)));
  need(
    campaigns.length === 1,
    `${campaigns.length} job(s) in ${FUZZ_NIGHTLY} actually invoke \`go test -fuzz\`; want exactly `
    + `one. Zero is a workflow that discovers its targets every night and fuzzes none of them, `
    + `which reports a green campaign for a search that never ran.`,
  );
  const [campaignName, campaign] = campaigns[0] ?? [];
  if (campaign) {
    const matrix = campaign.strategy?.matrix;
    need(
      typeof matrix === "string" && /fromJSON\(\s*needs\./.test(matrix),
      `${FUZZ_NIGHTLY}/${campaignName}: strategy.matrix is ${JSON.stringify(matrix)}, want a `
      + `\`fromJSON(needs.…)\` expression. A literal matrix is a hand-maintained target list `
      + `wearing YAML: it cannot notice a target that was added and never listed, and it goes `
      + `green either way.`,
    );
    if (typeof matrix === "string" && discoveryName) {
      need(
        matrix.includes(`needs.${discoveryName}.outputs.`),
        `${FUZZ_NIGHTLY}/${campaignName}: its matrix does not read an output of `
        + `\`${discoveryName}\`, the job that runs \`${FUZZ_INVENTORY}\` (matrix is `
        + `${JSON.stringify(matrix)}). A matrix fed by anything else is not fed by discovery.`,
      );
      const needs = campaign.needs;
      need(
        needs === discoveryName || (Array.isArray(needs) && needs.includes(discoveryName)),
        `${FUZZ_NIGHTLY}/${campaignName}: does not declare \`needs: ${discoveryName}\` `
        + `(needs is ${JSON.stringify(needs)}), so the matrix reads an output of a job that may `
        + `not have run.`,
      );
    }
    need(
      campaign.strategy?.["fail-fast"] === "false",
      `${FUZZ_NIGHTLY}/${campaignName}: strategy.fail-fast is `
      + `${JSON.stringify(campaign.strategy?.["fail-fast"])}, want false. These are independent `
      + `searches over independent code; one target crashing must not cancel the others and turn `
      + `their verdicts into "unknown".`,
    );

    // 7f. One bounded command, anchored on the target it was given.
    const text = runText(campaign);
    need(
      /-run\s+'\^\$'/.test(text),
      `${FUZZ_NIGHTLY}/${campaignName}: the fuzz command has no \`-run '^$'\`, so every ordinary `
      + `test in the package runs again here — they already ran on the pull request, and their `
      + `time comes out of the fuzz budget.`,
    );
    need(
      /-fuzz\s+'\^\$\{\{\s*matrix\.target\s*\}\}\$'/.test(text),
      `${FUZZ_NIGHTLY}/${campaignName}: the \`-fuzz\` pattern is not the anchored `
      + `\`'^\${{ matrix.target }}$'\`. Unanchored, one job's pattern also matches a future `
      + `target whose name extends it, and that target is then fuzzed twice while its own job `
      + `runs a shorter search.`,
    );
    need(
      /-count=1/.test(text),
      `${FUZZ_NIGHTLY}/${campaignName}: the fuzz command dropped \`-count=1\`, so a cached PASS `
      + `can stand in for a campaign that never ran.`,
    );

    const fuzzTime = goDurationMinutes(/-fuzztime\s+(\S+)/.exec(text)?.[1]);
    const testTimeout = goDurationMinutes(/-timeout\s+(\S+)/.exec(text)?.[1]);
    const jobTimeout = Number(campaign["timeout-minutes"]);
    need(
      Number.isFinite(fuzzTime) && fuzzTime > 0,
      `${FUZZ_NIGHTLY}/${campaignName}: no finite \`-fuzztime\`. Fuzzing without one runs until `
      + `the job timeout kills it, which reports as a timed-out job rather than as a clean `
      + `campaign that found nothing.`,
    );
    need(
      Number.isFinite(testTimeout) && testTimeout > 0,
      `${FUZZ_NIGHTLY}/${campaignName}: no finite \`-timeout\` on the go test command, so Go's `
      + `10-minute default applies and would kill a longer campaign as a test timeout.`,
    );
    need(
      !(Number.isFinite(fuzzTime) && Number.isFinite(testTimeout)) || fuzzTime < testTimeout,
      `${FUZZ_NIGHTLY}/${campaignName}: \`-fuzztime\` (${fuzzTime}m) is not below the go test `
      + `\`-timeout\` (${testTimeout}m). The harness would kill the campaign at its own budget `
      + `and print a goroutine dump for a run that was doing exactly what it was told.`,
    );
    need(
      !(Number.isFinite(testTimeout) && Number.isFinite(jobTimeout)) || testTimeout < jobTimeout,
      `${FUZZ_NIGHTLY}/${campaignName}: the go test \`-timeout\` (${testTimeout}m) is not below `
      + `the job's timeout-minutes (${jobTimeout}). The job bound would fire first and cancel the `
      + `runner before Go could write the crasher or the dump that explains why.`,
    );

    // 7g. The crasher artifact: the only durable output a failing night has.
    const uploads = (campaign.steps ?? []).filter(
      (step) => String(step?.uses ?? "").startsWith("actions/upload-artifact@"),
    );
    need(
      uploads.length === 1,
      `${FUZZ_NIGHTLY}/${campaignName}: ${uploads.length} upload-artifact step(s); want exactly `
      + `one. A crash writes a minimized, reproducing input under testdata/fuzz/; without the `
      + `upload the finding is a log line nobody can replay, and the corpus is not persisted `
      + `anywhere else in this wave.`,
    );
    for (const step of uploads) {
      need(
        step.if === "failure()",
        `${FUZZ_NIGHTLY}/${campaignName}: the crasher upload's \`if:\` is `
        + `${JSON.stringify(step.if)}, want "failure()". On a clean night there is nothing to `
        + `collect, and an unconditional upload publishes an empty artifact that reads as `
        + `"a crash was found and is empty".`,
      );
      need(
        /^actions\/upload-artifact@[0-9a-f]{40}$/.test(String(step.uses)),
        `${FUZZ_NIGHTLY}/${campaignName}: the crasher upload is \`${step.uses}\`, not pinned to a `
        + `full 40-character commit SHA. Every third-party action in this repository is; a tag `
        + `can be moved by a compromised or careless upstream, and this step runs in a job that `
        + `has just executed attacker-shaped input.`,
      );
      const retention = Number(step.with?.["retention-days"]);
      need(
        Number.isFinite(retention) && retention > 0,
        `${FUZZ_NIGHTLY}/${campaignName}: the crasher upload's retention-days is `
        + `${JSON.stringify(step.with?.["retention-days"])}, want a finite positive number. `
        + `The repository default outlives the fix, and a nightly job that keeps failing `
        + `accumulates one artifact per night.`,
      );
      need(
        typeof step.with?.path === "string" && step.with.path.includes("testdata/fuzz"),
        `${FUZZ_NIGHTLY}/${campaignName}: the crasher upload's path is `
        + `${JSON.stringify(step.with?.path)}, which does not name testdata/fuzz — the directory `
        + `\`go test -fuzz\` writes a failing input to. An upload aimed elsewhere succeeds and `
        + `collects nothing.`,
      );
      // The artifact name has to VARY per matrix row, and `matrix.id` is the
      // one field the inventory script guarantees is unique across rows — it
      // checks the ids for collision separately from the (package, target)
      // pairs, because flattening `/` to `-` is not injective. `matrix.target`
      // is the tempting alternative and is wrong: two packages may each define
      // a `FuzzDecode`, and then two jobs upload one artifact name.
      need(
        typeof step.with?.name === "string" && step.with.name.includes("matrix.id"),
        `${FUZZ_NIGHTLY}/${campaignName}: the crasher upload's name is `
        + `${JSON.stringify(step.with?.name)}, which is not derived from \`matrix.id\`. A name `
        + `that is constant, or that varies only by \`matrix.target\`, is shared by two jobs the `
        + `moment two packages define a target of the same name — and two jobs uploading one `
        + `artifact name lose one of the two minimized inputs, on a run that is red for a `
        + `different reason and where nobody is counting artifacts. \`matrix.id\` is the field `
        + `\`${FUZZ_INVENTORY}\` proves unique before it emits the matrix.`,
      );
    }
  }

  return out;
}

// ── 6k. the app-tree guards run on a change to the tree they read ───────────
//
// The same class of invisible gap as section 6, one level in. Section 6 governs
// which WORKFLOWS start; this governs whether the package's guard tests run for
// the file they guard. They are XCTest cases in `apps/RelayiumKit` that open
// files under `apps/ios` and `apps/mac`, no Xcode build runs them, and the only
// `swift test` that does is `swift-package.yml`'s unfiltered one — so that lane
// has to start on those trees, for every class of file the guards read, and it
// is the ONLY lane that should be running them.

/**
 * The ceiling section 6i already holds `file`/`jobName` to, or `undefined`.
 *
 * Derived rather than restated: a second copy of the number here would be free
 * to drift above 6i's the day somebody edits one of them.
 */
function governedCeiling(file, jobName) {
  const budget = RUNNER_BUDGETS.find((entry) => entry.file === file);
  if (budget === undefined) return undefined;
  return budget.jobs === undefined ? budget.max : budget.jobs[jobName]?.max;
}

/**
 * Keep the iOS lane parallel without letting the split become a coverage split.
 * Each job owns one evidence class and has no dependency edge to another job.
 */
function iosParallelLaneFailures(world) {
  const out = [];
  const need = (ok, message) => { if (!ok) out.push(message); };
  const doc = world.docs.get(IOS);
  if (!doc) return out;

  const wanted = ["ios-build", "ios-ui-smoke", "ios-ipad-shell"];
  const names = Object.keys(doc.jobs ?? {});
  need(
    names.length === wanted.length && wanted.every((name) => names.includes(name)),
    `${IOS} jobs are [${names.join(", ")}], want exactly [${wanted.join(", ")}]. The lane is `
    + `split by evidence class so build, UI and transfer acceptance run concurrently; adding, `
    + `removing or renaming a class is a CI architecture decision.`,
  );

  for (const name of wanted) {
    const job = doc.jobs?.[name];
    if (!job) continue;
    need(
      job.needs === undefined,
      `${IOS}/${name} declares \`needs: ${JSON.stringify(job.needs)}\`. The iOS evidence `
      + `classes are deliberately independent; this edge serializes paid macOS runners and `
      + `restores the previous 37-minute critical path.`,
    );
    need(
      job.if === undefined,
      `${IOS}/${name}: a job-level "if:" is back. Each evidence class must fail closed whenever `
      + `the iOS lane is selected.`,
    );
  }

  const body = (name) => JSON.stringify(doc.jobs?.[name] ?? {});
  const build = body("ios-build");
  need(
    !build.includes("swift test")
      && build.includes("generic/platform=iOS Simulator")
      && build.includes("generic/platform=iOS")
      && !build.includes("RelayiumUITests test")
      && !build.includes("local-transfer-acceptance.sh")
      && !build.includes("actions/setup-go"),
    `${IOS}/ios-build must own only the unsigned Simulator and Device compile graphs; UI, `
    + `transfer acceptance and Go setup belong to their parallel jobs, and the package's guard `
    + `tests belong to ${SWIFT_PACKAGE_LANE}, which runs the whole suite on \`apps/ios/**\`.`,
  );

  const ui = body("ios-ui-smoke");
  need(
    ui.includes("-only-testing:RelayiumUITests)") && ui.includes("scripts/ci/ios-ui-smoke.py")
      && !ui.includes("local-transfer-acceptance.sh")
      && !ui.includes("actions/setup-go"),
    `${IOS}/ios-ui-smoke must independently own the offline primary-task UI test and no transfer `
    + `or Go setup work.`,
  );

  const ipad = body(IOS_REGULAR_WIDTH_JOB);
  need(
    !ipad.includes("local-transfer-acceptance.sh") && !ipad.includes("actions/setup-go"),
    `${IOS}/${IOS_REGULAR_WIDTH_JOB} must own the regular-width shell and nothing else; transfer `
      + `acceptance and Go setup belong to ${IOS_TRANSFER_INTEROP}/ios-transfer-acceptance.`,
  );

  const transfer = JSON.stringify(world.docs.get(IOS_TRANSFER_INTEROP)?.jobs?.["ios-transfer-acceptance"] ?? {});
  for (const marker of [
    "actions/setup-go",
    "generic/platform=iOS Simulator",
    "local-transfer-acceptance.sh",
    "local-transfer-cleanup-test.sh",
    "ios-ui-session-acceptance.sh",
  ]) {
    need(
      transfer.includes(marker),
      `${IOS_TRANSFER_INTEROP}/ios-transfer-acceptance does not contain ${JSON.stringify(marker)}. The split may `
      + `shorten the critical path, but it may not drop a transfer prerequisite or acceptance case.`,
    );
  }

  return out;
}

// ── 6q: the regular-width shell is EXECUTED, not merely selected ────────────
//
// Everything below is about one failure and its near misses. `ios-ui-smoke`
// runs the whole UI target on an iPhone; `AdaptiveShellUITests` skips itself
// unless the shell is regular width; `xcodebuild` exits 0 for a run in which
// every selected case skipped. So the sidebar, the detail column and the
// stored-link presentation over a split view were covered on paper and executed
// nowhere, for as long as the class had existed.
//
// A job that "runs the iPad tests" is not enough to fix that, because the three
// ways it silently stops running them all leave a green job:
//
//   * the destination drifts back to an iPhone — one word in a `startswith`;
//   * the scope widens to the whole target, which duplicates the iPhone job's
//     twenty-odd unrelated cases on a second PAID macOS runner AND still lets
//     the regular-width cases skip inside it;
//   * the class is renamed, `-only-testing` resolves to nothing, and zero tests
//     run.
//
// Each is asserted here, and section 8 mutates each one.

/**
 * `ios.yml`'s iPad job: the destination, the scope, the proof it ran, and the
 * result bundle it leaves behind when it did not.
 */
function iosRegularWidthShellFailures(world) {
  const out = [];
  const need = (ok, message) => { if (!ok) out.push(message); };
  const doc = world.docs.get(IOS);
  if (!doc) return out;

  const job = doc.jobs?.[IOS_REGULAR_WIDTH_JOB];
  need(
    job !== undefined,
    `${IOS} declares no \`${IOS_REGULAR_WIDTH_JOB}\` job. ${IOS_COMPACT_JOB} selects an iPhone `
    + `and every ${IOS_REGULAR_WIDTH_CLASS} case skips on a compact shell, so without this job `
    + `the regular-width ${IOS_UI_TARGET} coverage is selected, skipped and reported green — the `
    + `state this section exists to end.`,
  );
  if (!job) return out;

  const where = `${IOS}/${IOS_REGULAR_WIDTH_JOB}`;
  const steps = job.steps ?? [];
  // Every `run:` body in the job, with shell comment lines dropped.
  //
  // Every check below is about what the job EXECUTES. A prose line explaining
  // why this job is not the compact one, or naming the selector it
  // deliberately does not use, is neither a destination nor a selection —
  // reading the comments too would make the refusals fire on documentation and
  // let the requirements be satisfied by it.
  const code = steps
    .map((step) => String(step?.run ?? ""))
    .join("\n")
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("#"))
    .join("\n");

  // ── the destination ──────────────────────────────────────────────────────
  //
  // A quoted `iPad` literal in EXECUTED code, paired with the refusal below.
  // Together they say "the selection names iPad and never iPhone"; the prose
  // is excluded from both, so a job whose comment says iPad and whose
  // `startswith` says iPhone — the regression this is written against — fails
  // the second one.
  need(
    /["']iPad["']/.test(code),
    `${where}: no step selects its simulator by an \`iPad\` name at all. This job's ONLY reason `
    + `to exist is a regular-width shell, which on this image means a full-screen iPad; a `
    + `destination chosen any other way is a job that duplicates ${IOS_COMPACT_JOB} at full `
    + `price.`,
  );
  need(
    !/iPhone/.test(code),
    `${where}: a step names \`iPhone\`. Selecting one here — or falling back to one when no iPad `
    + `is available — puts every ${IOS_REGULAR_WIDTH_CLASS} case straight back into the skip it `
    + `takes on ${IOS_COMPACT_JOB}, at the cost of a second PAID macOS runner and with nothing `
    + `going red. A missing iPad runtime is a runner-image regression this job must FAIL on.`,
  );

  // ── the scope ────────────────────────────────────────────────────────────
  need(
    code.includes(IOS_REGULAR_WIDTH_SELECTOR),
    `${where}: no step passes \`${IOS_REGULAR_WIDTH_SELECTOR}\`. That identifier is the whole `
    + `scope of this job; without it the job either runs something else or runs everything.`,
  );
  need(
    !code.includes(IOS_WHOLE_UI_TARGET_SELECTOR),
    `${where}: a step passes \`${IOS_WHOLE_UI_TARGET_SELECTOR}\`, the whole UI target. `
    + `${IOS_COMPACT_JOB} already runs it on an iPhone, and the size class is the only variable `
    + `that differs — so this re-runs every unrelated case on a second PAID macOS runner for no `
    + `second answer, and buries the regular-width result among cases that pass either way.`,
  );
  const selected = [...code.matchAll(new RegExp(`-only-testing[:=]\\s*${IOS_UI_TARGET}/([A-Za-z0-9_]+)`, "g"))]
    .map((match) => match[1]);
  for (const className of selected) {
    need(
      className === IOS_REGULAR_WIDTH_CLASS,
      `${where}: a step selects \`${IOS_UI_TARGET}/${className}\`. This job runs the ONE class `
      + `that cannot run on ${IOS_COMPACT_JOB}; anything else here is a duplicate paid run of a `
      + `case that already has a home. Adding a second regular-width-only class is a decision to `
      + `make in \`IOS_REGULAR_WIDTH_CLASS\`, where the cost is visible.`,
    );
  }
  need(
    world.uiTestClasses.includes(IOS_REGULAR_WIDTH_CLASS),
    `${where}: the job selects \`${IOS_UI_TARGET}/${IOS_REGULAR_WIDTH_CLASS}\`, but `
    + `${IOS_UI_TEST_DIR} declares no such class. \`xcodebuild\` runs zero tests for an `
    + `\`-only-testing\` identifier that resolves to nothing and exits 0, so this is a job that `
    + `reports green while executing nothing. Follow the rename here, or decide the class is `
    + `gone.`,
  );

  // ── the proof it ran ─────────────────────────────────────────────────────
  //
  // The one assertion that separates this job from the state it replaces. Every
  // check above is about SELECTION; a compact shell on an iPad-shaped
  // destination would satisfy all of them and skip anyway.
  need(
    /skippedTests/.test(code),
    `${where}: no step reads \`skippedTests\` out of the result bundle. Selection is not `
    + `execution: ${IOS_REGULAR_WIDTH_CLASS} skips whenever \`waitForShell\` does not report `
    + `regular width, \`xcodebuild\` exits 0 for an all-skipped run, and this job would then `
    + `report exactly the green ${IOS_COMPACT_JOB} already reports. Assert the counts.`,
  );
  need(
    /totalTestCount/.test(code),
    `${where}: no step requires the run to have executed any test at all. An \`-only-testing\` `
    + `identifier that matches nothing produces a bundle with zero cases and a successful exit; `
    + `a skip check alone passes that, because zero of zero skipped.`,
  );

  // ── the diagnosis it leaves behind ───────────────────────────────────────
  const bundle = code.match(/-resultBundlePath\s+"?([^"\s\\]+)/);
  need(
    bundle !== null,
    `${where}: no step declares \`-resultBundlePath\`. A UI failure on a hosted iPad simulator is `
    + `not reproducible from a log line, and there is nothing to attach without a bundle.`,
  );
  const retain = steps.find((step) => String(step?.uses ?? "").includes("actions/upload-artifact"));
  need(
    retain !== undefined,
    `${where}: nothing uploads the result bundle. ${IOS_COMPACT_JOB} retains its \`.xcresult\` on `
    + `failure and this job — which drives a device shape no developer's default simulator is — `
    + `needs it more, not less.`,
  );
  if (retain) {
    // Keyed to the TEST step's own outcome, not to `failure()`: since 6v a
    // failed simulator boot fails the job before the test step runs, and a bare
    // `failure()` would then upload a bundle that was never written and add a
    // second, misleading error to the real one.
    const condition = String(retain.if ?? "");
    need(
      /always\(\)/.test(condition) && condition.includes("steps.ipad_shell.outcome")
        && /['"]failure['"]/.test(condition) && /['"]cancelled['"]/.test(condition)
        && !/['"]success['"]/.test(condition) && !/\bfailure\(\)/.test(condition),
      `${where}: the result-bundle upload declares \`if: ${JSON.stringify(retain.if)}\`, want \`always()\` `
      + `gated on \`steps.ipad_shell.outcome\` being 'failure' or 'cancelled'. Uploading on every run pays for `
      + `an artifact nobody opens; uploading on none leaves the red run undiagnosable; a bare \`failure()\` `
      + `uploads a bundle that does not exist when the simulator never booted.`,
    );
    const path = String(retain.with?.path ?? "");
    need(
      bundle === null || path.includes(bundle[1].replace("$RUNNER_TEMP", "").replace(/^\/+/, "")),
      `${where}: the upload's \`path\` is ${JSON.stringify(path)}, which does not name the `
      + `\`-resultBundlePath\` the test step wrote (${JSON.stringify(bundle?.[1])}). An artifact `
      + `step pointed at the wrong path retains nothing and, with `
      + `\`if-no-files-found: error\`, hides the real failure behind its own.`,
    );
  }

  return out;
}

// ── 6u. the iPhone UI target runs as two shards, and the two are the whole ──
//
// `ios-ui-smoke` runs `RelayiumUITests` on an iPhone as a two-entry matrix:
// `app-shell` runs one class, `complement` runs the target minus that class.
// Splitting a suite is how coverage goes missing without anything turning red,
// so every way of getting the split wrong is a failure here:
//
//   * a class selected by NEITHER shard — a dropped matrix entry, a deleted
//     branch, or a complement written as a hand-kept class list that the next
//     new class is not on;
//   * a class selected by BOTH — the complement losing its `-skip-testing`,
//     which doubles the slowest class's cost and still looks green;
//   * a shard whose selection matched nothing or skipped everything, which
//     `xcodebuild` reports as success;
//   * the two shards' evidence colliding under one artifact name, or one
//     shard's red cancelling the other's run;
//   * the matrix quietly growing into a general fan-out of PAID runners.
//
// The partition is evaluated against the classes declared on disk, so adding a
// class is checked rather than assumed. It reads the selections with the
// semantics they are written for — `-skip-testing` removing a class from the
// `-only-testing` target — and `man xcodebuild`'s precedence note is why that
// is not taken on trust at run time: each shard also proves, from its own
// result bundle, which classes it actually executed.

const IOS_COMPACT_BOUNDARY_CLASS = "AppShellUITests";
/** The matrix, in order: the boundary class's shard, then everything else. */
const IOS_COMPACT_SHARDS = ["app-shell", "complement"];
/** The `id:` of the step that proves, from the result bundle, what ran. */
const IOS_COMPACT_PROOF_ID = "ui_shard_proof";

/** The branches of a `case` statement in a run body: label → branch text. */
function caseBranches(code) {
  const out = new Map();
  for (const match of code.matchAll(/^[ \t]*([A-Za-z0-9_*-]+)\)[ \t]*\n([\s\S]*?)^[ \t]*;;[ \t]*$/gm)) {
    out.set(match[1], match[2]);
  }
  return out;
}

/** The `-only-testing` / `-skip-testing` identifiers a branch passes. */
function testSelection(text) {
  const ids = (flag) => [...text.matchAll(new RegExp(`${flag}[:=]\\s*([A-Za-z0-9_/]+)`, "g"))]
    .map((match) => match[1]);
  return { only: ids("-only-testing"), skip: ids("-skip-testing") };
}

/** Does this selection run class `name` of the UI target? `null` selects nothing. */
function selectsClass(selection, name) {
  if (selection === null || selection === undefined) return false;
  const { only, skip } = selection;
  const hits = (id) => id === IOS_UI_TARGET || id === `${IOS_UI_TARGET}/${name}`;
  return (only.length === 0 || only.some(hits)) && !skip.some(hits);
}

function iosCompactShardFailures(world) {
  const out = [];
  const need = (ok, message) => { if (!ok) out.push(message); };
  const doc = world.docs.get(IOS);
  if (!doc) return out;
  const job = doc.jobs?.[IOS_COMPACT_JOB];
  if (!job) return out; // iosParallelLaneFailures reports the missing job.
  const where = `${IOS}/${IOS_COMPACT_JOB}`;

  // ── the matrix: exactly two shards, neither cancelling the other ─────────
  const planned = RUNNER_BUDGETS.find((entry) => entry.file === IOS)?.jobs?.[IOS_COMPACT_JOB]?.shards;
  need(
    planned === IOS_COMPACT_SHARDS.length,
    `${where}: this policy budgets ${String(planned)} runner(s) per run for this job, want `
    + `${IOS_COMPACT_SHARDS.length}. The split was costed at two shards — about 6.9 extra PAID `
    + `runner-minutes for a ~12-minute shorter critical path — and a different count is a new `
    + `cost decision, not a tidy-up.`,
  );
  const matrix = job.strategy?.matrix;
  const axes = matrix && typeof matrix === "object" ? Object.keys(matrix) : [];
  const shards = Array.isArray(matrix?.shard) ? matrix.shard.map(String) : matrix?.shard;
  need(
    axes.length === 1 && axes[0] === "shard"
      && Array.isArray(shards) && shards.join(",") === IOS_COMPACT_SHARDS.join(","),
    `${where}: matrix is ${JSON.stringify(matrix)}, want exactly \`shard: `
    + `[${IOS_COMPACT_SHARDS.join(", ")}]\` and no other axis, include or exclude. A missing entry `
    + `is half the UI target that silently stops running; an extra one is another PAID macOS `
    + `runner per run that nobody costed.`,
  );
  need(
    job.strategy?.["fail-fast"] === "false",
    `${where}: strategy.fail-fast is ${JSON.stringify(job.strategy?.["fail-fast"])}, want false. `
    + `With the default, one shard's failure cancels the other, which then reports \`cancelled\` `
    + `with its half of the evidence unknown.`,
  );
  for (const [name, other] of Object.entries(doc.jobs ?? {})) {
    if (name === IOS_COMPACT_JOB) continue;
    need(
      other?.strategy === undefined,
      `${IOS}/${name} gained a \`strategy\`. Only ${IOS_COMPACT_JOB} is sharded, and only in two; `
      + `${name === IOS_REGULAR_WIDTH_JOB ? "the iPad job runs one class once, and a matrix there "
        + "is a second paid run of it" : "a matrix here is an uncosted PAID fan-out"}.`,
    );
  }

  // ── the selection: one class, and the target minus that class ───────────
  const steps = job.steps ?? [];
  const test = steps.find((step) => step?.id === "ui_smoke");
  need(
    test !== undefined,
    `${where}: no step has \`id: ui_smoke\`, so there is no shard selection to check.`,
  );
  if (!test) return out;
  const code = String(test.run ?? "")
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("#"))
    .join("\n");
  need(
    /\$\{\{\s*matrix\.shard\s*\}\}/.test(String(test.env?.UI_SHARD ?? "")),
    `${where}: the test step does not receive \`UI_SHARD: \${{ matrix.shard }}\`, so the matrix `
    + `entry and the selection it runs are not connected.`,
  );
  need(
    code.includes('--test-result "$RUNNER_TEMP/ios-ui-smoke-$UI_SHARD.xcresult"')
      && code.includes('--build-result "$RUNNER_TEMP/ios-ui-build-$UI_SHARD.xcresult"'),
    `${where}: the result bundle path does not carry \`$UI_SHARD\`. Each shard's bundle is the `
    + `evidence for its half, and the proof and upload steps read it by that name (the build gets its own, `
    + `\`ios-ui-build-$UI_SHARD.xcresult\`, never accepted as test evidence).`,
  );

  const branches = caseBranches(code);
  const labels = [...branches.keys()];
  need(
    labels.length === IOS_COMPACT_SHARDS.length + 1
      && IOS_COMPACT_SHARDS.every((label) => branches.has(label)) && branches.has("*"),
    `${where}: the test step's \`case "$UI_SHARD"\` branches are [${labels.join(", ")}], want `
    + `[${IOS_COMPACT_SHARDS.join(", ")}, *]. A shard with no branch runs nothing; a branch with `
    + `no shard is selection nobody executes.`,
  );
  need(
    /\bexit\s+[1-9]/.test(branches.get("*") ?? ""),
    `${where}: the default \`*)\` branch does not exit non-zero. An unrecognised shard must fail, `
    + `not fall through to a run that selected nothing.`,
  );

  const selections = new Map();
  for (const shard of IOS_COMPACT_SHARDS) {
    const branch = branches.get(shard);
    // A shard with no branch selects nothing; the partition below then names
    // exactly the classes that stopped running.
    if (branch === undefined) { selections.set(shard, null); continue; }
    need(
      /^[ \t]*selection=\(/m.test(branch),
      `${where}: the \`${shard}\` branch assigns no \`selection=(…)\` array, so the helper's test runs no `
      + `selection of this shard's own.`,
    );
    const selection = testSelection(branch);
    selections.set(shard, selection);
    const all = [...selection.only, ...selection.skip];
    need(
      all.every((id) => id === IOS_UI_TARGET || /^[A-Za-z0-9_]+\/[A-Za-z0-9_]+$/.test(id)),
      `${where}: the \`${shard}\` branch selects [${all.join(", ")}]. The shards split at CLASS `
      + `boundaries; a method-level identifier is a partition this policy cannot evaluate.`,
    );
    need(
      all.every((id) => id === IOS_UI_TARGET || id.startsWith(`${IOS_UI_TARGET}/`)),
      `${where}: the \`${shard}\` branch selects outside ${IOS_UI_TARGET}: [${all.join(", ")}].`,
    );
  }
  const boundary = `${IOS_UI_TARGET}/${IOS_COMPACT_BOUNDARY_CLASS}`;
  const shell = selections.get("app-shell");
  if (shell) {
    need(
      shell.only.length === 1 && shell.only[0] === boundary && shell.skip.length === 0,
      `${where}: the \`app-shell\` shard selects only [${shell.only.join(", ")}] and skips `
      + `[${shell.skip.join(", ")}], want exactly \`-only-testing:${boundary}\`.`,
    );
  }
  const rest = selections.get("complement");
  if (rest) {
    need(
      rest.only.length === 1 && rest.only[0] === IOS_UI_TARGET
        && rest.skip.length === 1 && rest.skip[0] === boundary,
      `${where}: the \`complement\` shard selects only [${rest.only.join(", ")}] and skips `
      + `[${rest.skip.join(", ")}], want the target minus the boundary class: `
      + `\`-only-testing:${IOS_UI_TARGET}\` with \`-skip-testing:${boundary}\`. Naming the `
      + `remaining classes instead is a list the next new class is silently not on.`,
    );
  }

  need(
    world.uiTestClasses.includes(IOS_COMPACT_BOUNDARY_CLASS),
    `${where}: the shards split at \`${IOS_COMPACT_BOUNDARY_CLASS}\`, but ${IOS_UI_TEST_DIR} `
    + `declares no such class. The app-shell shard would select nothing, and the complement's `
    + `exclusion would exclude nothing.`,
  );
  for (const name of world.uiTestClasses) {
    const owners = IOS_COMPACT_SHARDS.filter((shard) => selectsClass(selections.get(shard), name));
    need(
      owners.length > 0,
      `${where}: ${IOS_UI_TARGET}/${name} is selected by no shard. Before the split one job ran `
      + `the whole target; a class neither half selects is coverage that stopped without a red.`,
    );
    need(
      owners.length < 2,
      `${where}: ${IOS_UI_TARGET}/${name} is selected by both shards [${owners.join(", ")}]. `
      + `The halves must be disjoint, or the class runs twice on PAID runners for one answer.`,
    );
  }

  // ── the proof each shard ran its half, and the evidence it keeps ─────────
  const proofAt = steps.findIndex((step) => step?.id === IOS_COMPACT_PROOF_ID);
  const proof = steps[proofAt];
  need(
    proof !== undefined && proofAt > steps.indexOf(test),
    `${where}: no step after the test has \`id: ${IOS_COMPACT_PROOF_ID}\`, so nothing proves a `
    + `shard executed anything. \`xcodebuild … test\` exits 0 when a selection matched nothing `
    + `or every case skipped.`,
  );
  if (proof) {
    const body = String(proof.run ?? "");
    need(
      /totalTestCount/.test(body) && /passedTests/.test(body),
      `${where}: the shard proof does not require both \`totalTestCount\` and \`passedTests\` to be `
      + `positive. Zero tests is green to xcodebuild, and so is a shard in which every case skipped.`,
    );
    need(
      /test-results tests/.test(body) && body.includes(IOS_COMPACT_BOUNDARY_CLASS),
      `${where}: the shard proof does not read the executed cases' classes (\`xcresulttool get `
      + `test-results tests\`) against \`${IOS_COMPACT_BOUNDARY_CLASS}\`. Counts alone cannot tell `
      + `a disjoint split from one whose complement ran the boundary class again.`,
    );
    need(
      proof.if === undefined && proof["continue-on-error"] === undefined,
      `${where}: the shard proof carries \`if:\`/\`continue-on-error\`. It must run whenever the `
      + `test step succeeded and fail the job when it fails.`,
    );
  }
  const upload = steps.find((step) => String(step?.uses ?? "").includes("actions/upload-artifact"));
  need(
    upload !== undefined,
    `${where}: nothing uploads a shard's result bundle on failure.`,
  );
  if (upload) {
    need(
      /\$\{\{\s*matrix\.shard\s*\}\}/.test(String(upload.with?.name ?? "")),
      `${where}: the diagnosis artifact is named ${JSON.stringify(upload.with?.name)}, which does `
      + `not carry \`\${{ matrix.shard }}\`. Both shards upload in the same run, and two uploads `
      + `under one name conflict — the second failing shard's evidence is lost.`,
    );
    need(
      /\$\{\{\s*matrix\.shard\s*\}\}/.test(String(upload.with?.path ?? "")),
      `${where}: the diagnosis upload's path ${JSON.stringify(upload.with?.path)} does not name the `
      + `shard's own result bundle.`,
    );
    need(
      String(upload.if ?? "").includes(`steps.${IOS_COMPACT_PROOF_ID}.outcome`),
      `${where}: the diagnosis upload does not run when the shard proof fails. A bundle that ran `
      + `the wrong half is the only record of what it ran.`,
    );
  }

  return out;
}

/**
 * The app-tree guards' coverage: the package lane starts on every class of file
 * they read, the tree's own build lane still does too, and neither Apple build
 * lane runs a `swift test` of its own.
 */
function appGuardCoverageFailures(world) {
  const out = [];
  const need = (ok, message) => { if (!ok) out.push(message); };

  need(
    APP_GUARD_INPUTS.length > 0,
    `this policy names no app-tree guard inputs at all, so every check below would pass by `
    + `inspecting an empty list.`,
  );

  for (const { lane, path, why } of APP_GUARD_INPUTS) {
    need(
      wTriggers(world, SWIFT_PACKAGE_LANE, path),
      `${SWIFT_PACKAGE_LANE} does not trigger on ${path}, which carries ${why}. The guards that `
      + `read that file are XCTest cases in the shared package; no \`xcodebuild\` runs them and `
      + `${lane} runs no \`swift test\`, so the package lane's unfiltered suite is the ONLY place `
      + `they execute. Narrowed off this file, a change to it compiles the app and accepts its UI `
      + `while nothing reads the declaration it just edited.`,
    );
    need(
      wTriggers(world, lane, path),
      `${lane} does not trigger on ${path}, which carries ${why}. That file is part of the app `
      + `this workflow builds; a filter rewritten as a list of narrower globs keeps the project `
      + `file starting the lane while taking plists, \`.strings\` catalogs or an extension out `
      + `of it.`,
    );
  }

  // The retired shape must not come back. `ios.yml` used to run a hand-kept
  // `--filter` list here; with the package lane watching `apps/ios/**` a
  // `swift test` in either Apple build lane is a second package build on a PAID
  // runner for an answer the package lane already gives — and a filtered one is
  // the list that drifted. `scripts/test/swift-ci-boundary-test.mjs` holds the
  // repository-wide host list; this is the statement about these two lanes.
  for (const file of [IOS, MACOS]) {
    const doc = world.docs.get(file);
    if (!doc) continue;
    const carriers = [];
    for (const [jobName, job] of Object.entries(doc.jobs ?? {})) {
      for (const step of job.steps ?? []) {
        if (String(step?.run ?? "").includes("swift test")) carriers.push(`${jobName}/${JSON.stringify(step?.name)}`);
      }
    }
    need(
      carriers.length === 0,
      `${file} runs \`swift test\` in [${carriers.join(", ")}]. The package's guard tests run in `
      + `${SWIFT_PACKAGE_LANE}, which starts on \`apps/ios/**\` and \`apps/mac/**\` and runs `
      + `the whole suite; a step here is a duplicate package build on a paid macOS runner, and a `
      + `\`--filter\` list here is the hand-kept subset that was retired because it drifted.`,
    );
  }

  return out;
}


// ── 6l. every PAID runner in a governed workflow is budgeted at all ─────────
//
// 6i enforces per-job completeness INSIDE a file it already budgets. It cannot
// notice a governed workflow that is in `RUNNER_BUDGETS` nowhere — which is how
// `native-web-pairing.yml`, a 45-minute macOS lane, sat unbudgeted while the
// list looked complete. A new macOS workflow lands the same way: its jobs
// declare whatever they declare, and nothing compares the number to anything.
//
// Only macOS jobs, because only they carry the paid-runner multiplier. An
// unbudgeted `ubuntu-latest` job is a real cost and a much smaller one, and 6f
// and 6h already bound the always-on lanes.
//
// The sweep covers the BUDGET-ONLY files too, and that is not a widening for its
// own sake. `macos-release.yml` is not governed — it has no `push` and no
// `pull_request` by design — and it holds a `macos-15` notarization job. A sweep
// restricted to the governed list would have looked complete while the one
// unbudgeted PAID lane in this repository sat in the file that submits to Apple
// with the notary key on disk. A file in neither list is still caught: it would
// be in no policy at all, which 6m and the missing-file checks report.
function macosBudgetFailures(world) {
  const out = [];
  const need = (ok, message) => { if (!ok) out.push(message); };

  const swept = [
    ...world.governed.map((entry) => entry.file),
    ...(world.budgetOnly ?? []),
  ];
  need(
    swept.length > 0,
    `this policy swept no workflow files for unbudgeted PAID runners at all, so every check `
    + `below passed by iterating over nothing.`,
  );
  for (const file of swept) {
    for (const [name, job] of Object.entries(world.docs.get(file)?.jobs ?? {})) {
      // `includes`, not `startsWith`: a conditional `runs-on` expression that can pick a
      // macOS image (macos.yml's `contract`, 6t) is a paid job on those runs.
      if (!String(job?.["runs-on"] ?? "").includes("macos")) continue;
      const ceiling = governedCeiling(file, name);
      need(
        Number.isFinite(ceiling),
        `${file}/${name} runs on ${JSON.stringify(job["runs-on"])} — a PAID runner — and section `
        + `6i declares no runner-budget ceiling for it (\`RUNNER_BUDGETS\` gives `
        + `${String(ceiling)}). Its \`timeout-minutes\` is then whatever the file happens to say `
        + `and nothing compares it to anything, so the 6-hour default can return by way of a `
        + `number nobody chose. Add the workflow, or the job, to \`RUNNER_BUDGETS\` with a `
        + `ceiling justified by what it actually does.`,
      );
      for (const { where, declared, value } of timeoutValues(job).values ?? []) {
        need(
          Number.isFinite(value) && value > 0,
          `${file}/${name}: ${where} is ${declared}, want a finite positive number. This job holds `
          + `a PAID macOS runner; undeclared, it inherits GitHub's 6-hour default.`,
        );
      }
    }
  }

  return out;
}

// ── 6t. macos.yml `contract`: Apple runner exactly when a release is intended ─
//
// `contract` is a checkout on every push, pull request and merge-gate call —
// including a merge-gate call whose caller was DISPATCHED, because the gate
// passes no inputs; its one step reaches `xcodebuild -showBuildSettings` and the
// readiness check only on release INTENT: a non-empty `release_version`,
// `notarize`, or `publish_release`. It used to wait ~7 minutes for a macOS
// runner to do 13 s of checkout (run 36736501756) while `ui-smoke` and
// `signed-build` waited on it, and until the event stopped counting as intent a
// dispatched gate still did (run 37175317336: 308 s queued, 9 s of work), so
// `runs-on` now picks `ubuntu-latest` unless one of the three inputs holds.
//
// The intent is written twice — once as a GitHub expression, once as shell —
// and nothing but this section keeps them equal. So nothing is taken from the
// text: the expression is evaluated, and the step's script is RUN, for EVERY
// event and EVERY combination of the three inputs (and for each event with no
// inputs at all), against stub `xcodebuild` and `node`. The runner must be
// exactly `macos-15` iff an input names a release. Run as Linux, an intent-free
// case must call no tool and pass, and an intent case must trip the runner guard
// before any tool; run as macOS, each intent case must reach exactly the
// original checks: version format, notarize=true for a version, the
// MARKETING_VERSION match, and publication only with a version from main after
// the approved readiness check. `notarize` alone is intent — the Apple runner,
// conservatively — and on macOS checks nothing further, as it always did.
const CONTRACT_STEP = "Validate release contract";
const CONTRACT_EVENTS = ["push", "pull_request", "workflow_dispatch"];
const CONTRACT_CASES = (() => {
  // [label, event, inputs (undefined: the event supplies none), intent?]
  const out = [];
  for (const event of CONTRACT_EVENTS) {
    out.push([`${event} with no inputs`, event, undefined, false]);
    for (const release_version of ["", "1.4.5"]) {
      for (const notarize of [false, true]) {
        for (const publish_release of [false, true]) {
          const inputs = { release_version, notarize, publish_release };
          const intent = release_version !== "" || notarize || publish_release;
          out.push([`${event} version=${JSON.stringify(release_version)} notarize=${notarize} publish=${publish_release}`, event, inputs, intent]);
        }
      }
    }
  }
  return out;
})();
/** What the macOS run of an intent case must do: [exit 0?, xcodebuild?, readiness?]. */
function contractMacExpect(inputs, ref = "refs/heads/main", marketing = "1.4.5") {
  const version = inputs.release_version;
  if (version !== "") {
    if (!/^[0-9]+(\.[0-9]+){1,2}$/.test(version)) return [false, false, false];
    if (!inputs.notarize) return [false, false, false];
    if (version !== marketing) return [false, true, false];
  }
  if (inputs.publish_release) {
    if (version === "" || ref !== "refs/heads/main") return [false, version !== "", false];
    return [true, true, true];
  }
  return [true, version !== "", false];
}

/** Evaluate a `${{ }}` runs-on for one case; throws on anything it does not model. */
function evalRunsOn(runsOn, event, inputs) {
  const m = /^\$\{\{([\s\S]*)\}\}$/.exec(String(runsOn).trim());
  if (!m) return String(runsOn);
  const js = m[1]
    .replace(/'([^']*)'/g, (_, lit) => JSON.stringify(lit))
    .replace(/\bgithub\.event_name\b/g, "ctx.event")
    .replace(/\binputs\.([a-z_]+)\b/g, "ctx.inputs?.$1")
    .replace(/!=/g, "!==").replace(/([^!=])==/g, "$1===");
  const bare = js.replace(/"[^"]*"/g, "").replace(/ctx\.(event|inputs\?\.[a-z_]+)/g, "");
  if (/[A-Za-z_$]/.test(bare)) throw new Error(`cannot evaluate runs-on ${runsOn}: unmodelled identifier`);
  // eslint-disable-next-line no-new-func
  return new Function("ctx", `return (${js});`)({ event, inputs });
}

function macosContractRunnerFailures(world) {
  const out = [];
  const need = (ok, message) => { if (!ok) out.push(message); };
  const job = world.docs.get(MACOS)?.jobs?.contract;
  const step = (job?.steps ?? []).find((s) => s?.name === CONTRACT_STEP);
  if (!job || typeof step?.run !== "string") {
    return [`${MACOS}/contract: no job, or no \`${CONTRACT_STEP}\` step with a run script, to check the runner against.`];
  }
  const dir = spawnSync("mktemp", ["-d", `${process.env.TMPDIR ?? "/tmp"}/macos-contract.XXXXXX`], { encoding: "utf8" })
    .stdout.trim();
  const stub = (tool) => `#!/bin/sh\necho "${tool} $*" >> "$TOOL_CALLS"\n`
    + (tool === "xcodebuild" ? "echo '    MARKETING_VERSION = 1.4.5'\n" : "exit \"${READINESS_EXIT:-0}\"\n");
  spawnSync("bash", ["-c", `mkdir -p "$1/bin" && printf '%s' "$2" > "$1/bin/xcodebuild" && printf '%s' "$3" > "$1/bin/node" `
    + `&& chmod +x "$1/bin/xcodebuild" "$1/bin/node" && printf '%s' "$4" > "$1/step.sh"`,
  "_", dir, stub("xcodebuild"), stub("node"), step.run]);
  const run = (os, event, inputs, n, { ref = "refs/heads/main", readiness = 0, tag = "" } = {}) => {
    const calls = `${dir}/calls-${n}-${os}${tag}`;
    const r = spawnSync("bash", [`${dir}/step.sh`], {
      encoding: "utf8",
      env: {
        PATH: `${dir}/bin:${process.env.PATH}`, TOOL_CALLS: calls, RUNNER_OS: os, READINESS_EXIT: String(readiness),
        GITHUB_EVENT_NAME: event, GITHUB_REF: ref,
        // How GitHub renders `${{ inputs.x }}`: absent inputs are empty, booleans are words.
        RELEASE_VERSION: inputs ? String(inputs.release_version) : "",
        NOTARIZE: inputs ? String(inputs.notarize) : "",
        PUBLISH_RELEASE: inputs ? String(inputs.publish_release) : "",
      },
    });
    const tools = spawnSync("cat", [calls], { encoding: "utf8" }).stdout ?? "";
    return { status: r.status, out: `${r.stdout}${r.stderr}`, tools };
  };
  const macMatches = (label, mac, [ok, xcode, ready]) => {
    need((mac.status === 0) === ok && /^xcodebuild /m.test(mac.tools) === xcode
      && /check-release-readiness\.mjs --require-approved/.test(mac.tools) === ready,
    `${MACOS}/contract (${label}): on macOS the step must ${ok ? "pass" : "refuse"}${xcode ? ", read MARKETING_VERSION" : ", read no MARKETING_VERSION"}`
      + `${ready ? " and run the readiness check" : " and run no readiness check"}; got exit ${mac.status}, tools [${mac.tools.trim()}].\n${mac.out}`);
  };
  CONTRACT_CASES.forEach(([label, event, inputs, intent], n) => {
    let runner;
    try {
      runner = evalRunsOn(job["runs-on"], event, inputs);
    } catch (err) {
      need(false, `${MACOS}/contract: ${err.message}. 6t cannot prove the runner choice, so it refuses it.`);
      return;
    }
    need(runner === "macos-15" || runner === "ubuntu-latest",
      `${MACOS}/contract (${label}): runs-on evaluates to ${JSON.stringify(runner)}; want macos-15 or ubuntu-latest.`);
    const linux = run("Linux", event, inputs, n);
    const reached = linux.status !== 0 || linux.tools !== "" || /release contract reached on/.test(linux.out);
    need(linux.tools === "",
      `${MACOS}/contract (${label}): run as Linux, the release-contract step called [${linux.tools.trim()}]. `
      + `Its runner guard must refuse a non-macOS runner before any Apple tool runs.`);
    need(!reached || runner === "macos-15",
      `${MACOS}/contract (${label}): the step reaches its release branch, but runs-on picks `
      + `${JSON.stringify(runner)}. Every release reachability must keep the Apple runner.`);
    need(intent || (!reached && runner === "ubuntu-latest"),
      `${MACOS}/contract (${label}): an ordinary run picks ${JSON.stringify(runner)}${reached ? " and reaches the release branch" : ""}; `
      + `want ubuntu-latest and a checkout only, so it does not queue for a macOS runner.`);
    need(!intent || (runner === "macos-15" && reached && /release contract reached on Linux/.test(linux.out)),
      `${MACOS}/contract (${label}): a release intent picks ${JSON.stringify(runner)}${reached ? "" : " and never reaches the release branch"}; `
      + `want macos-15 and the release branch (its Linux run refused by the runner guard).`);
    if (intent && runner === "macos-15") macMatches(label, run("macOS", event, inputs, n), contractMacExpect(inputs));
  });
  // The original release checks, each refusing on macOS for its own reason.
  for (const [label, inputs, opts, expect] of [
    ["invalid version format", { release_version: "1.4.5-beta", notarize: true, publish_release: false }, {}, [false, false, false]],
    ["a one-part version", { release_version: "2", notarize: true, publish_release: false }, {}, [false, false, false]],
    ["a version without notarize", { release_version: "1.4.5", notarize: false, publish_release: false }, {}, [false, false, false]],
    ["a version that is not MARKETING_VERSION", { release_version: "1.4.6", notarize: true, publish_release: false }, {}, [false, true, false]],
    ["publish without a version", { release_version: "", notarize: true, publish_release: true }, {}, [false, false, false]],
    ["publish from a branch other than main", { release_version: "1.4.5", notarize: true, publish_release: true }, { ref: "refs/heads/release" }, [false, true, false]],
    ["publish whose readiness check refuses", { release_version: "1.4.5", notarize: true, publish_release: true }, { readiness: 1 }, [false, true, true]],
    ["notarize alone (no new version required)", { release_version: "", notarize: true, publish_release: false }, {}, [true, false, false]],
  ]) {
    const want = opts.readiness ? expect : contractMacExpect(inputs, opts.ref);
    need(JSON.stringify(want) === JSON.stringify(expect), `${MACOS}/contract (${label}): 6t's own expectation table disagrees with its control`);
    macMatches(label, run("macOS", "workflow_dispatch", inputs, `x-${label.replace(/[^a-z0-9]+/gi, "-")}`, { ...opts, tag: "-x" }), expect);
  }
  spawnSync("rm", ["-rf", dir]);
  return out;
}

// ── 2 (continued). the concurrency rules, as a world function ──────────────
//
// The suffix is repository-wide. The PREFIX is per file, because two of them
// cannot use `${{ github.workflow }}`: see `LITERAL_GROUP_PREFIX`. Three rules
// follow from that, and all three are asserted here — the exact group each file
// must carry, the ban on `github.workflow` in a reusable CALLEE, and uniqueness
// of the resolved prefixes across every file governed here.
function concurrencyFailures(world) {
  const out = [];
  const need = (ok, message) => { if (!ok) out.push(message); };

  for (const file of CONCURRENCY_GOVERNED) {
    const doc = world.docs.get(file);
    if (!doc) continue;
    const group = doc.concurrency?.group;
    const cancel = doc.concurrency?.["cancel-in-progress"];

    need(
      group === expectedGroup(file),
      `${file}: concurrency.group is ${JSON.stringify(group)}, want `
      + `${JSON.stringify(expectedGroup(file))}.`,
    );
    need(
      cancel === CANCEL,
      `${file}: concurrency.cancel-in-progress is ${JSON.stringify(cancel)}, want `
      + `${JSON.stringify(CANCEL)} — only a pull request may supersede its own earlier run.`,
    );
    // Stated separately from the equality check above so the reason survives a
    // future edit that reformats the expression.
    need(
      typeof group !== "string" || !group.includes("github.ref"),
      `${file}: concurrency.group keys on \`github.ref\`. Every \`main\` run then shares one `
      + `group, and GitHub cancels an older PENDING run in a group even with `
      + `cancel-in-progress: false — so a quick second merge silently cancels the first `
      + `commit's verification and main shows a cancelled check for untested code.`,
    );
    need(
      typeof group !== "string" || group.includes("github.run_id"),
      `${file}: concurrency.group has no \`github.run_id\` fallback, so non-PR events share a `
      + `group and can cancel one another.`,
    );
    // A reusable CALLEE may not key on `${{ github.workflow }}`, whatever else
    // its group says. Stated as a property of `workflow_call` rather than of a
    // file name, so the next callee this repository grows is bound by it on the
    // day it lands.
    //
    // In a called workflow that expression is the CALLER's workflow name, not
    // this file's. The caller and the callee then share one group under one
    // `github.run_id`: GitHub holds the callee's jobs behind the caller's, and
    // the caller cannot finish until the callee does. That is a deadlock, and it
    // is invisible to YAML validity, to actionlint and to every run that never
    // exercised the call.
    if (doc.on && typeof doc.on === "object" && "workflow_call" in doc.on) {
      need(
        typeof group !== "string" || !group.includes("github.workflow"),
        `${file}: it is a reusable workflow (\`on: workflow_call\`) and its concurrency.group `
        + `keys on \`github.workflow\`. Inside a called workflow that expression is the CALLER's `
        + `name, so the caller's jobs and this file's jobs land in one group under one `
        + `\`github.run_id\` — the callee queues behind the caller that is waiting for it, and `
        + `the release run hangs until it is cancelled by hand. A reusable callee needs a LITERAL `
        + `prefix nothing else uses; \`LITERAL_GROUP_PREFIX\` is where to declare it.`,
      );
    }
  }

  // And the property no single file can hold up its own half of: the prefixes
  // are DISTINCT.
  //
  // `${{ github.workflow }}` is unique by construction — it is the file's own
  // `name:`. A literal is not: `macos-ci` and `macos-release` are two strings
  // somebody typed, and two workflows that resolve to the same prefix share a
  // group. For the pair this exists for, that is exactly the deadlock the rule
  // above prevents in the other direction — a literal `macos-release` in
  // `macos.yml` would collide with the caller's `${{ github.workflow }}` just as
  // surely as the expression itself did.
  //
  // So each file's prefix is resolved to what it will actually be at run time:
  // the literal where one is declared, and the workflow's `name:` where it is
  // not.
  const resolvedPrefixes = new Map();
  for (const file of CONCURRENCY_GOVERNED) {
    const doc = world.docs.get(file);
    if (!doc) continue;
    // Read off the group the file ACTUALLY declares, not off the policy table
    // above. The table says what each prefix should be; this says what it is,
    // and a collision introduced by editing a group is exactly the edit this
    // rule exists to catch.
    const group = typeof doc.concurrency?.group === "string" ? doc.concurrency.group : "";
    const declared = group.endsWith(`-${GROUP_SUFFIX}`)
      ? group.slice(0, -(GROUP_SUFFIX.length + 1))
      : group;
    // `${{ github.workflow }}` is not a prefix, it is a lookup: at run time it
    // is this file's own `name:`, so that is what it is compared as.
    const resolved = declared === DEFAULT_GROUP_PREFIX ? doc.name : declared;
    need(
      typeof resolved === "string" && resolved !== "",
      `${file}: its concurrency prefix resolves to ${JSON.stringify(resolved)}. A file with no `
      + `\`name:\` and no literal prefix has no resolvable group at all, and the uniqueness check `
      + `below would compare it against nothing.`,
    );
    if (typeof resolved !== "string" || resolved === "") continue;
    const owner = resolvedPrefixes.get(resolved);
    need(
      owner === undefined,
      `${file} and ${owner} both resolve their concurrency group to the prefix `
      + `${JSON.stringify(resolved)}, so every run of one shares a group with every run of the `
      + `other. Between a reusable caller and its callee that is a deadlock — the callee queues `
      + `behind the caller waiting for it. Between any other two it is one workflow cancelling or `
      + `blocking another's verification, and the board reports a CANCELLED check rather than a `
      + `missing one.`,
    );
    if (owner === undefined) resolvedPrefixes.set(resolved, file);
  }

  return out;
}


// ── 6m. the CI/release boundary, stated fail-closed ────────────────────────
//
// The one section here that is about a boundary between two FILES rather than
// about a property of one.
//
// `macos.yml` used to be both halves. It ran on every push to `main` and every
// pull request, and it also held `contents: write`, a `gh release create`, a
// `git push origin …:main`, an Apple notary API key and the Sparkle private
// signing key. Those release jobs were gated on `github.event_name ==
// 'workflow_dispatch' && inputs.…` — conditions that were correct, and that were
// the ONLY thing between an ordinary pull request and an immutable public
// release. One edited `if:`, one new job that forgot one, one input default
// flipped, and the YAML stays valid, actionlint stays happy, and the next signal
// is a public release nobody authorized.
//
// The split replaces that condition with a structure. `macos.yml` cannot publish
// because it contains nothing that publishes; `macos-release.yml` is the sole
// manual entry point, holds the only `contents: write` job in either file, and
// CALLS `macos.yml` so a release is built by the same signed-build lane every
// pull request already runs — not by a second pipeline that resembles it.
//
// Structure is only worth what the assertion that it stayed structural is worth,
// so every load-bearing part of it is named here rather than described:
//
//   * the callee's exact input set, secret set and output, with safe defaults —
//     an input or secret the callee does not need is one a future caller can be
//     asked to supply, and the notary and Sparkle secrets are deliberately not
//     among them;
//   * the caller's exact forwarding, written out one secret per line rather than
//     `secrets: inherit`, which would hand the CI half every secret this
//     repository holds, invisibly, and would keep growing as secrets are added;
//   * where each job lives, what it needs, and which single job may write;
//   * that the notarization job downloads the artifact the build NAMED, guarded
//     against that name being empty — which is what a skipped `signed-build`
//     produces, and what a dotted `jobs.signed-build` output expression produces;
//   * that no release or notarization operation is reachable with every input at
//     its default.
//
// Written as a world function, like every section above, so section 8 can break
// each rule and require the complaint.

/** The callee's `workflow_call` inputs: exactly these, all optional, CI defaults. */
const CALL_INPUTS = [
  { name: "release_version", type: "string", default: "" },
  { name: "notarize", type: "boolean", default: "false" },
  { name: "publish_release", type: "boolean", default: "false" },
];

/** The callee's `workflow_call` secrets: signing and profile material only. */
const CALL_SECRETS = [
  "MACOS_SIGNING_CERT_P12_BASE64",
  "MACOS_SIGNING_CERT_PASSWORD",
  "MACOS_PROVISIONING_PROFILE_BASE64",
  "MACOS_SHARE_PROVISIONING_PROFILE_BASE64",
];

/**
 * The caller's five dispatch inputs, verbatim: order, type, requiredness,
 * default and description.
 *
 * Verbatim because these are the operator's controls and they MOVED. A
 * description that drifted during the move is a lever whose label no longer
 * describes what it does, on the one workflow in this repository that can create
 * something permanent.
 */
const DISPATCH_INPUTS = [
  {
    name: "notarize",
    type: "boolean",
    required: "true",
    default: "false",
    description: "Submit the signed DMG to Apple, staple it, and run Gatekeeper verification",
  },
  {
    name: "validate_notary_credentials",
    type: "boolean",
    required: "true",
    default: "false",
    description: "Authenticate to Apple without submitting software",
  },
  {
    name: "validate_sparkle_key",
    type: "boolean",
    required: "true",
    default: "false",
    description: "Sign a disposable appcast entry and prove the update key matches the app",
  },
  {
    name: "release_version",
    type: "string",
    required: "false",
    default: "",
    description: "Stage immutable public-release metadata for this app version (for example 1.0)",
  },
  {
    name: "publish_release",
    type: "boolean",
    required: "true",
    default: "false",
    description:
      "Publish the versioned GitHub Release and deliver its appcast/download metadata to main",
  },
  // The sixth, and the only one that did not move from `macos.yml`: where the
  // signed DMG comes from. `auto` reuses only proven exact-main evidence.
  {
    name: "signed_build_source",
    type: "choice",
    required: "true",
    default: "auto",
    description: "Signed DMG source: auto (reuse proven exact-main evidence, else rebuild), "
      + "reuse (require it), build (always rebuild)",
    options: ["auto", "reuse", "build"],
  },
];

/** The jobs each half declares, exactly. */
const CI_JOBS = ["contract", "test", "ui-smoke", "signed-build"];
const RELEASE_JOBS = ["preflight", "build", "notarize-stage", "publish"];

/** The job in the callee whose output the caller consumes, and the output's name. */
const SIGNED_JOB = "signed-build";
const SIGNED_OUTPUT = "signed_artifact";
const SIGNED_STEP = "package_identity";
/** What the caller reads it as. One string, used by the guard and the download. */
const SIGNED_REF = `\${{ needs.build.outputs.${SIGNED_OUTPUT} }}`;

/**
 * Release material that may exist in the release workflow and nowhere else —
 * and, inside that workflow, only in the job that submits to Apple.
 */
const RELEASE_SECRETS = [
  "MACOS_NOTARY_KEY_P8_BASE64",
  "MACOS_NOTARY_KEY_ID",
  "MACOS_NOTARY_ISSUER_ID",
  "MACOS_SPARKLE_PRIVATE_KEY",
];

/** Operations an ordinary CI event must not be able to reach at all. */
const IRREVERSIBLE = [
  ["gh release create", "creates an immutable public release"],
  ["gh release upload", "replaces the assets of an existing one"],
  ["gh release edit", "rewrites a published release"],
  ["notarytool", "spends an Apple notarization submission"],
  ["git push", "writes to a branch of this repository"],
  ["secrets.GITHUB_TOKEN", "materializes the token those operations authenticate with"],
  ["contents: write", "grants that token the permission to do them"],
];

function releaseBoundaryFailures(world) {
  const out = [];
  const need = (ok, message) => { if (!ok) out.push(message); };

  const ci = world.docs.get(MACOS);
  const release = world.docs.get(MACOS_RELEASE);
  need(
    ci !== undefined,
    `${MACOS} is missing or did not parse, so the whole CI/release boundary below is unchecked. `
    + `It is the reusable callee this repository's macOS release is built by; a release that `
    + `cannot find it does not fail closed, it fails at dispatch time on the one workflow nobody `
    + `runs until they need it.`,
  );
  need(
    release !== undefined,
    `${MACOS_RELEASE} is missing or did not parse. It is the SOLE manual entry point for macOS `
    + `notarization and publication; without it the release path is gone, and the pressure that `
    + `creates is to put those jobs back into ${MACOS}, where an ordinary pull request can reach `
    + `them.`,
  );
  if (!ci || !release) return out;

  // ── the callee is CI, and read-only ──────────────────────────────────────
  const ciOn = ci.on ?? {};
  need(
    "workflow_call" in ciOn,
    `${MACOS} declares no \`workflow_call:\`, so ${MACOS_RELEASE} cannot call it and a release `
    + `would have to rebuild the app through some second definition of the same lane. One build `
    + `definition is the point: the bytes that get notarized are the bytes every pull request `
    + `already built.`,
  );
  need(
    !("workflow_dispatch" in ciOn),
    `${MACOS} has a \`workflow_dispatch:\` again. Every reason to start this file by hand is a `
    + `release reason, and release lives in ${MACOS_RELEASE}; a dispatch here is where the five `
    + `release inputs and the jobs that read them come back.`,
  );

  const call = ciOn.workflow_call && typeof ciOn.workflow_call === "object"
    ? ciOn.workflow_call
    : {};
  const declaredInputs = Object.keys(call.inputs ?? {});
  need(
    deepEqual(declaredInputs, CALL_INPUTS.map((input) => input.name)),
    `${MACOS}'s \`workflow_call\` declares inputs [${declaredInputs.join(", ")}]; want exactly `
    + `[${CALL_INPUTS.map((input) => input.name).join(", ")}]. Fewer is a caller passing something `
    + `nothing reads. MORE is the release surface growing back into the CI half one input at a `
    + `time — every input this file declares is one a job here may start acting on.`,
  );
  for (const want of CALL_INPUTS) {
    const input = call.inputs?.[want.name];
    if (input === undefined || typeof input !== "object") continue;
    need(
      input.required === "false" || input.required === undefined,
      `${MACOS}'s \`workflow_call\` input \`${want.name}\` is \`required: `
      + `${JSON.stringify(input.required)}\`. These three must be OPTIONAL: \`push\` and `
      + `\`pull_request\` supply no inputs at all, and a required call input is a caller-side `
      + `error rather than a default.`,
    );
    need(
      input.default === want.default,
      `${MACOS}'s \`workflow_call\` input \`${want.name}\` defaults to `
      + `${JSON.stringify(input.default)}, want ${JSON.stringify(want.default)}. The defaults ARE `
      + `the CI behaviour — an empty version and both booleans false is what an ordinary push `
      + `means. A default that names a release turns every caller that omits it into a release.`,
    );
    need(
      input.type === want.type,
      `${MACOS}'s \`workflow_call\` input \`${want.name}\` is \`type: `
      + `${JSON.stringify(input.type)}\`, want ${JSON.stringify(want.type)}.`,
    );
  }

  const declaredSecrets = Object.keys(call.secrets ?? {});
  need(
    deepEqual(declaredSecrets.slice().sort(), CALL_SECRETS.slice().sort()),
    `${MACOS}'s \`workflow_call\` declares secrets [${declaredSecrets.join(", ")}]; want exactly `
    + `[${CALL_SECRETS.join(", ")}]. These four are the signing certificate and the two `
    + `provisioning profiles, which its own jobs use. The notary key and the Sparkle private key `
    + `are deliberately absent: no job here reads them, and a callee that declares a secret it `
    + `never uses is a callee a future caller can be asked to hand one to.`,
  );

  const output = call.outputs?.[SIGNED_OUTPUT];
  need(
    output !== undefined && typeof output === "object",
    `${MACOS}'s \`workflow_call\` declares no \`${SIGNED_OUTPUT}\` output. It is the only value `
    + `the caller gets from this file, and without it the notarization job has to re-derive the `
    + `artifact name from inputs it hopes still agree with what the build used.`,
  );
  const value = typeof output?.value === "string" ? output.value : "";
  need(
    value.includes(`jobs['${SIGNED_JOB}']`) || value.includes(`jobs["${SIGNED_JOB}"]`),
    `${MACOS}'s \`${SIGNED_OUTPUT}\` output is ${JSON.stringify(value)}, which does not read `
    + `\`jobs['${SIGNED_JOB}']\` in BRACKET form. A hyphen in a property path is parsed as `
    + `subtraction, so \`jobs.${SIGNED_JOB}.outputs.…\` evaluates to the empty string — the `
    + `workflow stays valid, the output is silently empty, and the caller downloads nothing under `
    + `a name it was never given.`,
  );
  need(
    value.includes(`outputs.${SIGNED_OUTPUT}`),
    `${MACOS}'s \`${SIGNED_OUTPUT}\` output is ${JSON.stringify(value)}, which does not read the `
    + `\`${SIGNED_JOB}\` job's \`${SIGNED_OUTPUT}\` output.`,
  );

  // The job half of the same wire: one canonical name, emitted once and consumed
  // by both the upload and the output.
  const signed = ci.jobs?.[SIGNED_JOB];
  need(
    signed !== undefined,
    `${MACOS} declares no \`${SIGNED_JOB}\` job, which is what produces the artifact the release `
    + `notarizes and what the workflow output above reads.`,
  );
  if (signed) {
    const jobOutput = signed.outputs?.[SIGNED_OUTPUT];
    need(
      typeof jobOutput === "string" && jobOutput.includes(`steps.${SIGNED_STEP}.outputs.`),
      `${MACOS}/${SIGNED_JOB}: its \`${SIGNED_OUTPUT}\` job output is `
      + `${JSON.stringify(jobOutput)}, which does not read a \`${SIGNED_STEP}\` step output. The `
      + `artifact name has to come from the step that COMPUTED it; re-deriving it in the mapping `
      + `is a second copy of the naming expression, and the first rename makes the caller ask for `
      + `an artifact this run never uploaded.`,
    );
    const stepName = /steps\.[A-Za-z0-9_]+\.outputs\.([A-Za-z0-9_-]+)/.exec(jobOutput ?? "")?.[1];
    const upload = (signed.steps ?? []).find(
      (step) => String(step?.uses ?? "").startsWith("actions/upload-artifact"),
    );
    need(
      upload !== undefined,
      `${MACOS}/${SIGNED_JOB} uploads no artifact, so there is nothing for the release workflow `
      + `to download and the output above names a build that was never published to the run.`,
    );
    need(
      stepName === undefined
        || String(upload?.with?.name ?? "").includes(`steps.${SIGNED_STEP}.outputs.${stepName}`),
      `${MACOS}/${SIGNED_JOB}: the upload names the artifact `
      + `${JSON.stringify(upload?.with?.name)}, which is not the same `
      + `\`steps.${SIGNED_STEP}.outputs.${stepName}\` value the job output publishes. One `
      + `canonical name, emitted once and read by both — two expressions that agree today is `
      + `exactly the shape that stops agreeing under an edit to one of them.`,
    );
    const emitted = (signed.steps ?? [])
      .filter((step) => step?.id === SIGNED_STEP)
      .map((step) => String(step?.run ?? ""))
      .join("\n");
    need(
      stepName === undefined || emitted.includes(`${stepName}=`),
      `${MACOS}/${SIGNED_JOB}: no \`${SIGNED_STEP}\` step writes \`${stepName}=\` to `
      + `\`$GITHUB_OUTPUT\`, so the job output and the upload both read a step output nothing `
      + `sets — an empty artifact name that fails in the CALLER, one paid signing run later.`,
    );
  }

  // ── and it can reach none of the irreversible operations ─────────────────
  need(
    deepEqual(Object.keys(ci.jobs ?? {}), CI_JOBS),
    `${MACOS} declares jobs [${Object.keys(ci.jobs ?? {}).join(", ")}]; want exactly `
    + `[${CI_JOBS.join(", ")}]. This file runs on every push to \`main\` and every pull request; `
    + `a job added here is a job an ordinary CI event runs, and the two that are NOT here — `
    + `\`notarize-stage\` and \`publish\` — are the reason the split exists.`,
  );
  need(
    deepEqual(ci.permissions, { contents: "read" }),
    `${MACOS} declares top-level permissions ${JSON.stringify(ci.permissions)}, want `
    + `{"contents":"read"}. This workflow reads the repository, builds and signs; it writes `
    + `nothing back, and the token it is handed should not be able to.`,
  );
  for (const [name, job] of Object.entries(ci.jobs ?? {})) {
    need(
      job.permissions === undefined,
      `${MACOS}/${name} declares its own \`permissions:\` (${JSON.stringify(job.permissions)}). `
      + `No job in the CI half may widen the read-only default — a job-level block is precisely `
      + `how \`contents: write\` came to live in a workflow that runs on every pull request.`,
    );
  }
  const ciText = world.texts.get(MACOS) ?? "";
  need(
    ciText !== "",
    `${MACOS}'s comment-stripped source never reached this world, so every absence check below `
    + `would inspect the empty string and report a pass.`,
  );
  for (const [command, why] of IRREVERSIBLE) {
    need(
      !ciText.includes(command),
      `${MACOS} contains \`${command}\`, which ${why}. That file runs on every push to \`main\` `
      + `and every pull request. Whatever condition guards it, the guard is one edit from not `
      + `being there — which is the state this split replaced. The operations that cannot be `
      + `undone live in ${MACOS_RELEASE}, behind a manual dispatch, and nowhere else.`,
    );
  }
  for (const secret of RELEASE_SECRETS) {
    need(
      !ciText.includes(secret),
      `${MACOS} references \`${secret}\`. The notary key and the Sparkle private signing key are `
      + `release material: a workflow that materializes them on a runner reachable from a pull `
      + `request has made them reachable from a pull request, whether or not anything uses them `
      + `there yet.`,
    );
  }

  // ── the caller is manual, and is the only thing that can release ─────────
  const releaseOn = release.on ?? {};
  need(
    deepEqual(Object.keys(releaseOn), ["workflow_dispatch"]),
    `${MACOS_RELEASE} triggers on [${Object.keys(releaseOn).join(", ")}]; want exactly `
    + `[workflow_dispatch]. A \`push\`, \`pull_request\` or \`schedule\` trigger here makes an `
    + `automatic event able to start the jobs that notarize and publish — which is the whole of `
    + `what the split removed, restored in one line.`,
  );
  const dispatch = releaseOn.workflow_dispatch;
  const dispatchInputs = dispatch && typeof dispatch === "object"
    ? Object.keys(dispatch.inputs ?? {})
    : [];
  need(
    deepEqual(dispatchInputs, DISPATCH_INPUTS.map((input) => input.name)),
    `${MACOS_RELEASE}'s dispatch inputs are [${dispatchInputs.join(", ")}]; want exactly `
    + `[${DISPATCH_INPUTS.map((input) => input.name).join(", ")}], in that order. Five are the `
    + `operator's controls that MOVED here from ${MACOS} and the sixth chooses the signed-build `
    + `source; an input dropped is a decision that can no longer be made, and one added is a `
    + `lever with no history behind its default.`,
  );
  for (const want of DISPATCH_INPUTS) {
    const input = dispatch && typeof dispatch === "object" ? dispatch.inputs?.[want.name] : undefined;
    if (input === undefined || typeof input !== "object") continue;
    if (want.options !== undefined) {
      need(
        deepEqual(input.options, want.options),
        `${MACOS_RELEASE}'s dispatch input \`${want.name}\` offers ${JSON.stringify(input.options)}, `
        + `want ${JSON.stringify(want.options)}. A new choice is a signed-build source no judge `
        + `was written for.`,
      );
    }
    for (const key of ["type", "required", "default", "description"]) {
      need(
        input[key] === want[key],
        `${MACOS_RELEASE}'s dispatch input \`${want.name}\` declares ${key} `
        + `${JSON.stringify(input[key])}, want ${JSON.stringify(want[key])}. These five were `
        + `copied from ${MACOS} verbatim; a value that drifted during the move is a control whose `
        + `label or default no longer describes what it does, on the one workflow here that can `
        + `create something permanent.`,
      );
    }
  }
  need(
    deepEqual(release.permissions, { contents: "read" }),
    `${MACOS_RELEASE} declares top-level permissions ${JSON.stringify(release.permissions)}, want `
    + `{"contents":"read"}. Only \`publish\` needs more, and it declares that for itself; a `
    + `top-level write would hand it to the reusable call and to the notarization job as well.`,
  );
  need(
    deepEqual(Object.keys(release.jobs ?? {}), RELEASE_JOBS),
    `${MACOS_RELEASE} declares jobs [${Object.keys(release.jobs ?? {}).join(", ")}]; want exactly `
    + `[${RELEASE_JOBS.join(", ")}]. The build is a CALL, not a copy; a fourth job here is `
    + `unbudgeted release work, and a missing one is a stage of the release that moved somewhere `
    + `less guarded.`,
  );

  // The call itself: local, explicit, forwarding exactly four secrets.
  const build = release.jobs?.build;
  if (build) {
    need(
      build.uses === `./.github/workflows/${MACOS}`,
      `${MACOS_RELEASE}/build declares \`uses: ${JSON.stringify(build.uses)}\`, want `
      + `\`./.github/workflows/${MACOS}\`. It must call THIS repository's CI half at the commit `
      + `being released — a remote or tagged reference would notarize bytes built by a definition `
      + `that is not the one under review.`,
    );
    const passed = Object.keys(build.with ?? {});
    need(
      deepEqual(passed, CALL_INPUTS.map((input) => input.name)),
      `${MACOS_RELEASE}/build passes [${passed.join(", ")}]; want exactly `
      + `[${CALL_INPUTS.map((input) => input.name).join(", ")}] — the inputs the callee declares `
      + `and its jobs read. Passing an input the callee does not declare fails the run; omitting `
      + `one silently releases under the callee's CI default.`,
    );
    for (const want of CALL_INPUTS) {
      const wired = build.with?.[want.name];
      need(
        wired === undefined || String(wired).includes(`inputs.${want.name}`),
        `${MACOS_RELEASE}/build wires \`${want.name}\` to ${JSON.stringify(wired)}, which does `
        + `not read this workflow's own \`inputs.${want.name}\`. A control wired to the wrong `
        + `input reports the operator's decision to a job that was never given it.`,
      );
    }
    need(
      typeof build.secrets === "object" && build.secrets !== null && !Array.isArray(build.secrets),
      `${MACOS_RELEASE}/build declares \`secrets: ${JSON.stringify(build.secrets)}\`. It must be `
      + `an explicit MAPPING, never \`inherit\`: \`inherit\` hands the callee every secret this `
      + `repository holds — the notary key and the Sparkle private key included — invisibly, and `
      + `keeps doing so as new secrets are added. The CI half needs four, uses four, and is given `
      + `four.`,
    );
    const forwarded = Object.keys(
      typeof build.secrets === "object" && build.secrets !== null ? build.secrets : {},
    );
    need(
      deepEqual(forwarded.slice().sort(), CALL_SECRETS.slice().sort()),
      `${MACOS_RELEASE}/build forwards secrets [${forwarded.join(", ")}]; want exactly `
      + `[${CALL_SECRETS.join(", ")}]. Forwarding fewer breaks the signing steps with a message `
      + `that names a runbook rather than this line; forwarding more sends release material into `
      + `the half that must not be able to release.`,
    );
    need(
      deepEqual(build.permissions, { actions: "read", contents: "read", "pull-requests": "read" }),
      `${MACOS_RELEASE}/build declares \`permissions: ${JSON.stringify(build.permissions)}\`; want `
      + `exactly {"actions":"read","contents":"read","pull-requests":"read"}. A caller's permission `
      + `block is the ceiling of the called workflow: \`macos.yml\`'s evidence job reads runs and `
      + `pull requests, and GitHub rejects a callee job asking for more than its caller grants. `
      + `Anything beyond these three READS — any write — hands the CI half a lever it must not hold `
      + `when a release run is what started it.`,
    );
  }

  // The two release stages: order, guard, and the artifact they actually read.
  // ── the signed-build source: rebuild, or reuse proven exact-main evidence ──
  const preflight = release.jobs?.preflight;
  if (preflight) {
    need(
      preflight["runs-on"] === "ubuntu-latest" && preflight.needs === undefined,
      `${MACOS_RELEASE}/preflight runs on ${JSON.stringify(preflight["runs-on"])} with needs `
      + `${JSON.stringify(preflight.needs)}; want ubuntu-latest and nothing before it. It is the `
      + `free, first decision every release waits on, made before a paid minute is spent.`,
    );
    need(
      deepEqual(preflight.permissions, { actions: "read", contents: "read" }),
      `${MACOS_RELEASE}/preflight declares permissions ${JSON.stringify(preflight.permissions)}, want `
      + `{"actions":"read","contents":"read"}: it reads runs, jobs and artifacts and writes nothing.`,
    );
    const text = JSON.stringify(preflight);
    need(
      text.includes("node scripts/release/macos-evidence.mjs select")
        && text.includes("node scripts/release/macos-evidence.mjs publish-preflight"),
      `${MACOS_RELEASE}/preflight no longer runs both \`macos-evidence.mjs select\` and `
      + `\`publish-preflight\`; the reuse decision and the publication contract are made nowhere.`,
    );
    need(
      preflight.outputs?.source === "${{ steps.select.outputs.source }}",
      `${MACOS_RELEASE}/preflight's \`source\` output is ${JSON.stringify(preflight.outputs?.source)}; `
      + `it must be the judge's own decision.`,
    );
  }
  if (build) {
    need(
      build.needs === "preflight" && build.if === "needs.preflight.outputs.source == 'build'",
      `${MACOS_RELEASE}/build declares needs ${JSON.stringify(build.needs)} and if `
      + `${JSON.stringify(build.if)}; want \`preflight\` and exactly `
      + `\`needs.preflight.outputs.source == 'build'\`. Anything wider builds AND reuses; anything `
      + `narrower notarizes nothing whenever the evidence is unavailable.`,
    );
  }
  const notarize = release.jobs?.["notarize-stage"];
  if (notarize) {
    need(
      deepEqual(notarize.needs, ["preflight", "build"]),
      `${MACOS_RELEASE}/notarize-stage declares \`needs: ${JSON.stringify(notarize.needs)}\`, want `
      + `\`[preflight, build]\`. Depending on the CALL means depending on every job inside it — `
      + `\`contract\`, \`test\`, \`ui-smoke\` and \`signed-build\` — so nothing here can start `
      + `while any part of the macOS gate is red; depending on the preflight is what tells it the `
      + `call was skipped because a proven build is being reused.`,
    );
    const cond = String(notarize.if ?? "");
    for (const clause of [
      "!cancelled()",
      "needs.preflight.result == 'success'",
      "(needs.preflight.outputs.source == 'build' && needs.build.result == 'success')",
      "(needs.preflight.outputs.source == 'reuse' && needs.build.result == 'skipped')",
    ]) {
      need(
        cond.includes(clause),
        `${MACOS_RELEASE}/notarize-stage's condition no longer states \`${clause}\`. With the `
        + `build skipped on reuse the implicit success() is false, so the two sources must be `
        + `spelled out — and a source whose build result is not checked notarizes a red build.`,
      );
    }
    need(
      !/\balways\(\)/.test(cond),
      `${MACOS_RELEASE}/notarize-stage's condition uses always(), which starts notarizing a `
      + `cancelled release; use !cancelled().`,
    );
    need(
      deepEqual(notarize.permissions, { actions: "read", contents: "read" }),
      `${MACOS_RELEASE}/notarize-stage declares permissions ${JSON.stringify(notarize.permissions)}, `
      + `want {"actions":"read","contents":"read"}: the reuse readback re-reads the run and `
      + `re-downloads its artifact, and nothing here writes.`,
    );
    const steps = notarize.steps ?? [];
    const at = (pred) => steps.findIndex(pred);
    const runs = (needle) => (step) => String(step?.run ?? "").includes(needle);
    const verifyAt = at(runs("scripts/release/macos-evidence-verify-app.sh"));
    const readbackAt = at(runs("node scripts/release/macos-evidence.mjs readback"));
    const contractAt = at(runs("scripts/release/macos-evidence-release-contract.sh"));
    const firstSecretAt = at((step) => RELEASE_SECRETS.some((secret) => JSON.stringify(step).includes(secret)));
    const firstToolAt = at((step) => /\$tools\/generate_appcast|generate_appcast"\s*\\?\s*$|\|\s*"\$tools/.test(String(step?.run ?? ""))
      || String(step?.run ?? "").includes('"$tools/generate_appcast"'));
    need(
      verifyAt !== -1 && steps[verifyAt].if === undefined,
      `${MACOS_RELEASE}/notarize-stage does not unconditionally run `
      + `\`scripts/release/macos-evidence-verify-app.sh\`. Signature, team, direct channel, arch, `
      + `entitlements, privacy manifests and versions are proven on the mounted image for BOTH `
      + `sources or for neither.`,
    );
    need(
      readbackAt !== -1 && steps[readbackAt].if === "needs.preflight.outputs.source == 'reuse'"
        && readbackAt < verifyAt,
      `${MACOS_RELEASE}/notarize-stage must re-prove a reused build with \`macos-evidence.mjs `
      + `readback\` (if source == 'reuse') BEFORE the package verification; found readback at `
      + `${readbackAt + 1}, verification at ${verifyAt + 1}.`,
    );
    need(
      contractAt !== -1 && steps[contractAt].if === undefined && contractAt > verifyAt,
      `${MACOS_RELEASE}/notarize-stage must run the release contract unconditionally after the `
      + `package is verified (a reuse skipped \`macos.yml\`'s contract job); found it at `
      + `${contractAt + 1}.`,
    );
    for (const [label, index] of [["the first release secret", firstSecretAt],
      ["the first generate_appcast execution", firstToolAt]]) {
      need(
        index === -1 || (verifyAt !== -1 && verifyAt < index && contractAt !== -1 && contractAt < index),
        `${MACOS_RELEASE}/notarize-stage reaches ${label} at step ${index + 1}, before the package `
        + `verification (${verifyAt + 1}) and the release contract (${contractAt + 1}). Neither a `
        + `secret nor a restored tool may be touched by bytes nothing has verified yet.`,
      );
    }
    const downloadAt = steps.findIndex(
      (step) => String(step?.uses ?? "").startsWith("actions/download-artifact"),
    );
    need(
      downloadAt !== -1,
      `${MACOS_RELEASE}/notarize-stage downloads no artifact, so whatever it notarizes is not the `
      + `signed package the build produced.`,
    );
    need(
      downloadAt === -1 || steps[downloadAt]?.with?.name === SIGNED_REF,
      `${MACOS_RELEASE}/notarize-stage downloads the artifact named `
      + `${JSON.stringify(steps[downloadAt]?.with?.name)}, want ${JSON.stringify(SIGNED_REF)}. `
      + `Re-deriving the name here from \`github.sha\` and \`inputs.release_version\` is a second `
      + `copy of the callee's naming expression in a second file: the first rename makes this `
      + `download look for something this run never uploaded, and it fails after the signing `
      + `runner has already been paid for.`,
    );
    const guardAt = steps.findIndex(
      (step) => typeof step?.run === "string"
        && Object.values(step?.env ?? {}).some((v) => String(v) === SIGNED_REF),
    );
    need(
      guardAt !== -1,
      `${MACOS_RELEASE}/notarize-stage has no step that reads ${JSON.stringify(SIGNED_REF)} into `
      + `a shell variable and checks it. A SKIPPED job satisfies \`needs:\` and contributes EMPTY `
      + `outputs — \`signed-build\` is skipped on a fork pull request, and a dotted `
      + `\`jobs.signed-build\` output expression evaluates to the empty string — so without a `
      + `guard this job asks for an artifact named "" and fails on a missing artifact rather than `
      + `on the reason there is no artifact.`,
    );
    need(
      guardAt === -1 || downloadAt === -1 || guardAt < downloadAt,
      `${MACOS_RELEASE}/notarize-stage checks the build's artifact name at step ${guardAt + 1}, `
      + `AFTER the download at step ${downloadAt + 1}. A guard that runs after the thing it `
      + `guards is not a guard.`,
    );
    const guard = guardAt === -1 ? "" : String(steps[guardAt]?.run ?? "");
    need(
      guardAt === -1 || (/-z\s+"?\$/.test(guard) && /exit\s+1/.test(guard)),
      `${MACOS_RELEASE}/notarize-stage's artifact-name check does not FAIL on an empty value `
      + `(${JSON.stringify(guard.trim())}). Reading the value and continuing is the same as not `
      + `reading it.`,
    );
    need(
      steps[guardAt]?.if === undefined,
      `${MACOS_RELEASE}/notarize-stage's artifact-name guard carries \`if: `
      + `${JSON.stringify(steps[guardAt]?.if)}\`. A conditional guard is a guard that can skip `
      + `itself, and a skipped step reports nothing rather than red.`,
    );
  }

  const publish = release.jobs?.publish;
  if (publish) {
    need(
      publish.needs === "notarize-stage",
      `${MACOS_RELEASE}/publish declares \`needs: ${JSON.stringify(publish.needs)}\`, want `
      + `\`notarize-stage\`. Publication consumes the notarized, stapled bytes and the staged `
      + `metadata that job produces; a publish that does not wait for it would create an `
      + `immutable release around whatever the build alone left behind.`,
    );
    need(
      deepEqual(publish.permissions, {
        actions: "write",
        contents: "write",
      }),
      `${MACOS_RELEASE}/publish declares permissions ${JSON.stringify(publish.permissions)}, want `
      + `exactly {"actions":"write","contents":"write"}. Contents pushes the frozen branch and `
      + `fast-forwards main; actions dispatches and reads the candidate's merge gate. Delivery `
      + `opens no pull request — this repository's Actions token may not — so \`pull-requests\` `
      + `is not a permission it needs, and these stay on the publish job, not the workflow.`,
    );
    const cond = String(publish.if ?? "");
    need(
      cond.includes("!cancelled()") && cond.includes("needs.notarize-stage.result == 'success'")
        && !/\balways\(\)/.test(cond),
      `${MACOS_RELEASE}/publish's condition (${JSON.stringify(cond)}) must require `
      + `\`!cancelled()\` and \`needs.notarize-stage.result == 'success'\` explicitly: on a reused `
      + `build the transitive \`build\` need is skipped, so the implicit success() never publishes, `
      + `and always() would publish a cancelled release.`,
    );
  }
  const releaseText = world.texts.get(MACOS_RELEASE) ?? "";
  need(
    !releaseText.includes("gh pr create") && !/pull-requests:\s*write/.test(releaseText)
      && Object.entries(release.jobs ?? {}).every(([name, job]) => job?.permissions?.["pull-requests"] === undefined
        || (name === "build" && job.permissions["pull-requests"] === "read")),
    `${MACOS_RELEASE} creates a pull request or asks for a pull-request permission again. This `
    + `repository's Actions token cannot create one (can_approve_pull_request_reviews=false), which `
    + `failed the first publish of five releases; delivery dispatches merge-gate's strict frozen `
    + `mode on the candidate branch instead.`,
  );
  need(
    releaseText.includes("-f mode=frozen-release-metadata")
      && releaseText.includes("node scripts/release/macos-evidence.mjs gate-run --action verify"),
    `${MACOS_RELEASE} no longer dispatches merge-gate in \`mode=frozen-release-metadata\` and `
    + `re-verifies the finished gate run with \`macos-evidence.mjs gate-run --action verify\`.`,
  );
  const writers = Object.entries(release.jobs ?? {})
    .filter(([, job]) => job?.permissions?.contents === "write")
    .map(([name]) => name);
  need(
    deepEqual(writers, ["publish"]),
    `[${writers.join(", ")}] hold \`contents: write\` in ${MACOS_RELEASE}; want exactly `
    + `[publish]. Ordinary signed builds, credential checks and notarization candidates cannot `
    + `publish anything, and that is a property of which job holds the token rather than of what `
    + `each job happens to run today.`,
  );

  // The notarization material lives in ONE job of ONE file.
  for (const secret of RELEASE_SECRETS) {
    const hosts = Object.entries(release.jobs ?? {})
      .filter(([, job]) => JSON.stringify(job).includes(secret))
      .map(([name]) => name);
    need(
      deepEqual(hosts, ["notarize-stage"]),
      `\`${secret}\` is referenced by [${hosts.join(", ")}] in ${MACOS_RELEASE}; want exactly `
      + `[notarize-stage]. Zero is the notarization or the update signature quietly not `
      + `happening; more than one is release material materialized on a runner that has no reason `
      + `to hold it.`,
    );
  }

  // ── and nothing releases on the defaults ─────────────────────────────────
  //
  // Every input above defaults to false or empty. With all of them left alone
  // this workflow must build and stop, so each release stage is required to
  // condition on a dispatch AND on an input that is not at its default. A stage
  // whose `if:` lost that clause runs on every dispatch — including the one
  // somebody starts to get a signed build.
  for (const [name, levers] of [
    ["notarize-stage", ["inputs.notarize", "inputs.validate_notary_credentials",
      "inputs.validate_sparkle_key", "inputs.release_version"]],
    ["publish", ["inputs.publish_release"]],
  ]) {
    const condition = release.jobs?.[name]?.if;
    need(
      typeof condition === "string" && condition.includes("github.event_name == 'workflow_dispatch'"),
      `${MACOS_RELEASE}/${name} declares \`if: ${JSON.stringify(condition)}\`, which does not `
      + `require \`github.event_name == 'workflow_dispatch'\`. It is redundant today — this `
      + `workflow has no other trigger — and it is the assertion that survives the day somebody `
      + `adds one.`,
    );
    for (const lever of levers) {
      need(
        typeof condition === "string" && condition.includes(lever),
        `${MACOS_RELEASE}/${name}'s condition (${JSON.stringify(condition)}) no longer reads `
        + `\`${lever}\`. Every input defaults to false or empty; a stage that stops asking runs on `
        + `a dispatch where the operator asked for nothing but a signed build.`,
      );
    }
  }

  // ── the budgets moved with the jobs ──────────────────────────────────────
  const ciBudget = RUNNER_BUDGETS.find((entry) => entry.file === MACOS);
  const releaseBudget = RUNNER_BUDGETS.find((entry) => entry.file === MACOS_RELEASE);
  need(
    releaseBudget !== undefined,
    `\`RUNNER_BUDGETS\` has no entry for ${MACOS_RELEASE}, so the notarization job — a PAID macOS `
    + `runner holding Apple's notary key — and the publication job are bounded by whatever the `
    + `file happens to say, compared against nothing.`,
  );
  for (const job of ["notarize-stage", "publish"]) {
    need(
      releaseBudget?.jobs?.[job] !== undefined,
      `\`RUNNER_BUDGETS\` budgets no \`${job}\` job for ${MACOS_RELEASE}. Its budget MOVED with `
      + `the job rather than being dropped; a job that arrives in a new file with no ceiling is `
      + `the 6-hour default returning by way of a move nobody finished.`,
    );
    need(
      ciBudget?.jobs?.[job] === undefined,
      `\`RUNNER_BUDGETS\` still budgets \`${job}\` under ${MACOS}, which no longer declares it. A `
      + `budget naming a job that is gone enforces nothing, and it makes the list look complete `
      + `while the job it used to name is budgeted somewhere else or nowhere.`,
    );
  }

  return out;
}


// ── 6n. the aggregate merge gate, and what makes its green mean something ───
//
// This is the section about the one status `main`'s protection can require.
//
// Branch protection requires a CONTEXT, and a context satisfies a requirement
// only if it reports. A path-filtered workflow that does not trigger emits no
// check run at all, so protection cannot tell "this lane passed" from "this
// lane was legitimately not selected" from "this lane never ran" — which is why
// eight filtered lanes reported red over a merge button that still worked, and
// why pull request #22 merged over a failed Device Inbox job and an in-progress
// iOS job. `merge-gate.yml` is unfiltered, calls every lane, and reports one
// job that is always present and judges what the lanes actually did.
//
// Every load-bearing part of that is invisible to YAML validity and to
// actionlint, and each has a specific fail-open shape:
//
//   * A lane called and missing from the aggregate's `needs:` can FAIL while
//     `merge-gate` reports success.
//   * A lane in `needs:` and no longer called can only ever be skipped, and the
//     two-way rule then requires it to stay skipped forever.
//   * A condition written `needs.select.outputs.swift-package` is parsed as
//     SUBTRACTION, evaluates to the empty string, and the lane silently never
//     runs — while the gate stays green because it reads as "not selected".
//   * A result whitelist of `success|skipped` passes a lane that WAS selected
//     and then got skipped by a broken `if:`. That is the exact fail-open shape
//     this gate exists to close, reintroduced one edit later. The rule has to
//     be TWO-WAY: selected implies success, and not selected implies skipped.
//   * `secrets: inherit` on any caller hands the signing certificate and the
//     provisioning profiles to lanes that read no secret at all.
//   * A second job named `merge-gate` anywhere is the same GitHub App posting
//     the same context, so an unrelated green lane can satisfy the requirement
//     on behalf of the aggregate that never ran — the one substitution the
//     `app_id` binding cannot see. Same reasoning as 6j, different name.
//
// What this section does NOT assert is that the context is required. That is a
// live repository setting, not tree state. `docs/CI-PLATFORM-BOUNDARY.md`
// carries the staged protection migration and its current position.

/** The exact result pairings the aggregate may accept, and nothing else. */
const GATE_ACCEPTED = ["false:skipped", "true:success"];
/** This gate parses a few JSON blobs; a bound far above that is the default. */
const GATE_TIMEOUT_MAX = 10;

function aggregateGateFailures(world) {
  const out = [];
  const need = (ok, message) => { if (!ok) out.push(message); };

  const gate = world.docs.get(AGGREGATE);
  need(
    gate !== undefined,
    `${AGGREGATE} is missing or did not parse, so every rule below is unchecked. It is the only `
    + `workflow that reports a status on every pull request regardless of what changed, and `
    + `therefore the only one \`main\`'s protection can require without wedging the pull requests `
    + `that legitimately select no filtered lane.`,
  );
  if (!gate) return out;

  const lanes = [...GATE_LANES.keys()];
  const roster = [SELECT_JOB, ...lanes, ...GATE_ALWAYS];
  const jobs = gate.jobs ?? {};

  // -- the trigger: ordinary PRs plus the identity-bound release candidate --
  need(
    deepEqual(Object.keys(gate.on ?? {}), ["pull_request", "workflow_dispatch"]),
    `${AGGREGATE} triggers on [${Object.keys(gate.on ?? {}).join(", ")}]; want exactly `
    + `[pull_request, workflow_dispatch]. The dispatch exists only for a frozen release `
    + `candidate whose exact PR/base/head identity is checked by the selector job. A \`push:\` `
    + `would duplicate main CI, and a \`schedule:\` would run lanes on a tree nobody changed.`,
  );
  const gateDispatch = gate.on?.workflow_dispatch;
  const gateDispatchInputs = gateDispatch && typeof gateDispatch === "object"
    ? gateDispatch.inputs ?? {}
    : {};
  need(
    deepEqual(Object.keys(gateDispatchInputs), ["mode", "pr_number", "base_sha", "head_sha"]),
    `${AGGREGATE}'s workflow_dispatch inputs are [${Object.keys(gateDispatchInputs).join(", ")}]; `
    + `want exactly [mode, pr_number, base_sha, head_sha]. They bind a manually started check to `
    + `one frozen candidate rather than providing a general-purpose green status.`,
  );
  const modeInput = gateDispatchInputs.mode;
  need(
    modeInput?.type === "choice" && modeInput?.required === "true"
      && modeInput?.default === "pull-request"
      && deepEqual(modeInput?.options, ["pull-request", "frozen-release-metadata", "internal-full-candidate", "full-bootstrap"]),
    `${AGGREGATE}'s dispatch \`mode\` must be a required choice of exactly [pull-request, `
    + `frozen-release-metadata, internal-full-candidate, full-bootstrap] defaulting to pull-request; got ${JSON.stringify(modeInput)}.`,
  );
  need(
    gateDispatchInputs.pr_number?.type === "string" && gateDispatchInputs.pr_number?.required === "false",
    `${AGGREGATE}'s \`pr_number\` must be an optional string (the frozen mode has no pull `
    + `request); got ${JSON.stringify(gateDispatchInputs.pr_number)}.`,
  );
  {
    const collect = (jobs[SELECT_JOB]?.steps ?? []).find((step) => step?.id === "files");
    const body = String(collect?.run ?? "");
    for (const [needle, why] of [
      ['[[ "$PR_NUMBER" =~ ^[1-9][0-9]*$ ]] || status=identity-input-error',
        "the pull-request mode no longer requires a pull request number now the input is optional"],
      ['git worktree add --detach "$judge" "$EXPECTED_BASE"',
        "the frozen judge no longer runs from BASE's tree, so the candidate judges itself"],
      ['node "$judge/scripts/release/macos-evidence.mjs" frozen-candidate',
        "the frozen mode no longer runs base's macos-evidence.mjs frozen-candidate judge"],
      ['echo "::error::the dispatched commit is not a frozen release-metadata candidate"; exit 1; }',
        "a frozen candidate that fails the judge no longer FAILS the selector"],
      ['echo "::error::unknown dispatch mode ${MODE:-empty}"',
        "an unknown dispatch mode no longer fails the selector"],
      ['judge="$RUNNER_TEMP/internal-base"\n  git worktree add --detach "$judge" "$EXPECTED_BASE"',
        "the internal judge no longer runs from BASE's tree, so the candidate judges itself"],
      ['node "$judge/scripts/ci/ci-evidence.mjs" internal-candidate --output "$RUNNER_TEMP/internal.out"',
        "the internal mode no longer runs base's ci-evidence.mjs internal-candidate judge"],
      ['echo "::error::the dispatched commit is not an internal full candidate"; exit 1; }',
        "an internal candidate that fails the judge no longer FAILS the selector"],
      ["grep -qx 'status=internal-full-candidate' \"$RUNNER_TEMP/internal.out\" || {",
        "an internal judge that wrote no verdict no longer fails the selector"],
    ]) {
      need(body.includes(needle), `${AGGREGATE}/${SELECT_JOB}: ${why} (missing \`${needle}\`).`);
    }
    const judge = String((jobs[GATE_JOB]?.steps ?? []).map((step) => step?.run ?? "").join("\n"));
    need(
      judge.includes('if [ "$DISPATCHED" = true ] && [ "$MODE" = frozen-release-metadata ]; then\n'
        + '  if [ "$CHECKED_SHA" != "$EXPECTED_HEAD" ]'),
      `${AGGREGATE}/${GATE_JOB} no longer re-checks, where the verdict is given, that a frozen `
      + `release-metadata run checked the dispatched head on a release-candidate branch.`,
    );
    need(
      judge.includes('if [ "$DISPATCHED" = true ] && [ "$MODE" = internal-full-candidate ]; then\n'
        + '  if [ "$CHECKED_SHA" != "$EXPECTED_HEAD" ] || [ "$GITHUB_REF" != "refs/heads/internal-candidate/$EXPECTED_HEAD" ]; then'),
      `${AGGREGATE}/${GATE_JOB} no longer re-checks, where the verdict is given, that an internal full `
      + `candidate run checked the dispatched head on the internal-candidate branch named for it.`,
    );
    need(
      judge.includes('    if [ "$selected" != true ]; then\n'
        + '      note "internal full candidate mode: $lane was selected=\\"$selected\\"; this mode runs every lane."'),
      `${AGGREGATE}/${GATE_JOB} no longer requires an internal full candidate run to have selected every lane.`,
    );
  }
  for (const name of ["base_sha", "head_sha"]) {
    const input = gateDispatchInputs[name];
    need(
      input?.required === "true" && input?.type === "string",
      `${AGGREGATE}'s workflow_dispatch input ${name} must be a required string; got `
      + `${JSON.stringify(input)}. An optional identity component lets a dispatch guess what it `
      + `is checking.`,
    );
  }
  const prPaths = gate.on?.pull_request && typeof gate.on.pull_request === "object"
    ? gate.on.pull_request.paths
    : undefined;
  need(
    prPaths === undefined,
    `${AGGREGATE} has grown a \`pull_request\` path filter (${JSON.stringify(prPaths)}). A `
    + `filtered gate does not report on the changes it filters out, and a required context that `
    + `sometimes does not report blocks every pull request that does not select it — which is `
    + `precisely the state this workflow exists to replace.`,
  );
  need(
    deepEqual(gate.permissions, { contents: "read" }),
    `${AGGREGATE} declares top-level permissions ${JSON.stringify(gate.permissions)}, want `
    + `{"contents":"read"}. A caller's permission block is passed to every workflow it calls, so `
    + `a write here would hand a write token to the lane that imports a Developer ID certificate.`,
  );

  // -- the roster, compared in both directions ------------------------------
  need(
    deepEqual(Object.keys(jobs).slice().sort(), [...roster, GATE_JOB].sort()),
    `${AGGREGATE} declares jobs [${Object.keys(jobs).join(", ")}]; want exactly `
    + `[${[...roster, GATE_JOB].join(", ")}]. A lane added here and nowhere else is a lane the `
    + `aggregate cannot see; a lane removed is coverage that went away without anything saying so.`,
  );

  // -- the selector job -----------------------------------------------------
  const select = jobs[SELECT_JOB];
  need(select !== undefined, `${AGGREGATE} declares no \`${SELECT_JOB}\` job, which is what reads `
    + `the lanes' own path filters and decides which of them this change set requires.`);
  if (select) {
    const timeout = Number(select["timeout-minutes"]);
    need(
      Number.isFinite(timeout) && timeout > 0 && timeout <= GATE_TIMEOUT_MAX,
      `${AGGREGATE}/${SELECT_JOB}: timeout-minutes is `
      + `${JSON.stringify(select["timeout-minutes"])}, want a finite number no greater than `
      + `${GATE_TIMEOUT_MAX}. This job reads one API page and a handful of YAML filters; unbounded `
      + `it holds GitHub's six-hour default in front of every merge.`,
    );
    need(
      deepEqual(select.permissions, { contents: "read", "pull-requests": "read" }),
      `${AGGREGATE}/${SELECT_JOB} declares permissions ${JSON.stringify(select.permissions)}, `
      + `want {"contents":"read","pull-requests":"read"}. It reads the pull request's file list `
      + `and nothing else; a write scope here is a write token on every pull request.`,
    );
    need(
      deepEqual(Object.keys(select.outputs ?? {}), lanes),
      `${AGGREGATE}/${SELECT_JOB} publishes outputs [${Object.keys(select.outputs ?? {}).join(", ")}]; `
      + `want exactly [${lanes.join(", ")}]. A lane with no selector output can never be `
      + `selected, so its caller condition is false on every pull request and the aggregate `
      + `happily requires it to stay skipped.`,
    );
    for (const lane of lanes) {
      const value = select.outputs?.[lane];
      if (value === undefined) continue;
      need(
        value === `\${{ steps.${SELECT_JOB}.outputs['${lane}'] }}`,
        `${AGGREGATE}/${SELECT_JOB}'s \`${lane}\` output is ${JSON.stringify(value)}; want `
        + `\`\${{ steps.${SELECT_JOB}.outputs['${lane}'] }}\` in BRACKET form. A hyphen in an `
        + `expression property path is parsed as subtraction, so the dotted spelling evaluates to `
        + `the empty string — valid YAML, valid expression syntax, and a lane that is never `
        + `selected.`,
      );
    }
    need(
      runText(select).includes(`node ${SELECTOR}`),
      `${AGGREGATE}/${SELECT_JOB} no longer runs \`node ${SELECTOR}\`. That script is the only `
      + `thing that reads the lanes' own \`push.paths\`; without it the gate is selecting lanes by `
      + `some second declaration of the same filters, which is the drift surface this design `
      + `refused to create.`,
    );
    need(
      select.if === undefined && select["continue-on-error"] === undefined,
      `${AGGREGATE}/${SELECT_JOB} declares an \`if:\` or \`continue-on-error:\`. A selector that `
      + `can skip itself or report green after failing makes every lane condition below false, `
      + `and the aggregate would then require every lane to be skipped.`,
    );
  }

  // -- the callers ----------------------------------------------------------
  const gateText = world.texts.get(AGGREGATE) ?? "";
  need(
    gateText !== "",
    `${AGGREGATE}'s comment-stripped source never reached this world, so the absence checks below `
    + `would inspect the empty string and report a pass.`,
  );
  need(
    !/secrets:\s*inherit/.test(gateText),
    `${AGGREGATE} uses \`secrets: inherit\`. That hands the callee EVERY secret this repository `
    + `holds — the signing certificate and both provisioning profiles today, whatever is added `
    + `tomorrow — to lanes that read no secret at all, invisibly, and keeps doing so as the secret `
    + `list grows. Forward secrets one line at a time, to the one lane that uses them.`,
  );

  for (const [lane, workflow] of [...GATE_LANES, ...GATE_ALWAYS.map((l) => [l, `${l}.yml`])]) {
    const job = jobs[lane];
    if (job === undefined) continue;
    need(
      job.uses === `./.github/workflows/${workflow}`,
      `${AGGREGATE}/${lane} declares \`uses: ${JSON.stringify(job.uses)}\`; want `
      + `\`./.github/workflows/${workflow}\`. A LOCAL path, so the lane that runs is the `
      + `definition under review — a remote or tagged reference judges the pull request by `
      + `somebody else's copy of the lane.`,
    );
    need(
      world.texts.has(workflow),
      `${AGGREGATE}/${lane} calls ${workflow}, which is not in .github/workflows/. GitHub fails `
      + `the ENTIRE run to load, so \`${GATE_JOB}\` never reports: fail closed, but the merge box `
      + `shows a MISSING required check rather than a red one, which is close to undiagnosable `
      + `from the pull request.`,
    );
    need(
      job["timeout-minutes"] === undefined,
      `${AGGREGATE}/${lane} declares \`timeout-minutes:\` on a \`uses:\` job. GitHub rejects that `
      + `key on a reusable-workflow call and the whole run fails to load; the budget belongs to `
      + `the called workflow's own jobs, and section 6i already holds it there.`,
    );
    need(
      job.with === undefined,
      `${AGGREGATE}/${lane} passes \`with: ${JSON.stringify(job.with)}\`. The gate passes NO `
      + `inputs: every callee's defaults are its CI defaults, and an input supplied here is a `
      + `release lever an ordinary pull request just pulled.`,
    );
    need(
      job.needs === SELECT_JOB,
      `${AGGREGATE}/${lane} declares \`needs: ${JSON.stringify(job.needs)}\`, want `
      + `\`${SELECT_JOB}\`. Every lane waits on the selection, including the unconditional ones — `
      + `otherwise a lane starts before the job whose outputs its sibling conditions read.`,
    );
  }

  for (const lane of lanes) {
    const job = jobs[lane];
    if (job === undefined) continue;
    need(
      job.if === `needs.${SELECT_JOB}.outputs['${lane}'] == 'true'`,
      `${AGGREGATE}/${lane} declares \`if: ${JSON.stringify(job.if)}\`; want `
      + `\`needs.${SELECT_JOB}.outputs['${lane}'] == 'true'\`. Two failures share this line. A `
      + `constant or a widened condition runs a lane the change set did not select, which the `
      + `aggregate's two-way rule then reports as red for the wrong reason; and the DOTTED `
      + `spelling \`needs.${SELECT_JOB}.outputs.${lane}\` is parsed as subtraction, evaluates to `
      + `the empty string, and the lane silently never runs at all.`,
    );
    const secrets = job.secrets;
    if (lane === "macos") {
      need(
        typeof secrets === "object" && secrets !== null && !Array.isArray(secrets)
          && deepEqual(Object.keys(secrets).slice().sort(), CALL_SECRETS.slice().sort()),
        `${AGGREGATE}/macos forwards secrets ${JSON.stringify(secrets)}; want exactly the four `
        + `signing and profile secrets [${CALL_SECRETS.join(", ")}], written one per line. Fewer `
        + `breaks the signing steps with a message that names a runbook rather than this line; `
        + `more sends release material into the half that must not be able to release.`,
      );
    } else {
      need(
        secrets === undefined,
        `${AGGREGATE}/${lane} declares \`secrets: ${JSON.stringify(secrets)}\`. This lane reads no `
        + `secret at all today, and a secret it is handed is a secret it can start reading.`,
      );
    }
  }

  for (const lane of GATE_ALWAYS) {
    const job = jobs[lane];
    if (job === undefined) continue;
    need(
      job.if === undefined,
      `${AGGREGATE}/${lane} has grown an \`if: ${JSON.stringify(job.if)}\`. This lane hosts the `
      + `guards every change must pass — it carries no path filter for the same reason — so `
      + `nothing may stand between a pull request and it.`,
    );
    // The same rule the conditional lanes get, and it was missing here.
    //
    // `macos` is the only caller in this workflow that may be handed anything,
    // and it is a CONDITIONAL lane — so every unconditional one must be handed
    // nothing, on exactly the reasoning the loop above uses. Leaving these two
    // out meant the cheapest, most-often-edited callers in the file were the
    // only ones a secret could be added to without a check complaining, and
    // `compat` is the one that runs on literally every pull request.
    need(
      job.secrets === undefined,
      `${AGGREGATE}/${lane} declares \`secrets: ${JSON.stringify(job.secrets)}\`. This lane runs `
      + `UNCONDITIONALLY, on every pull request including a fork's, and reads no secret at all `
      + `today — a secret it is handed is a secret it can start reading, on the widest exposure `
      + `surface this workflow has.`,
    );
  }

  // -- the aggregate itself -------------------------------------------------
  const aggregate = jobs[GATE_JOB];
  need(aggregate !== undefined, `${AGGREGATE} declares no \`${GATE_JOB}\` job. That job key and `
    + `its \`name:\` ARE the required status context; without it protection waits on a context `
    + `nothing in this repository reports.`);
  if (aggregate) {
    need(
      aggregate.name === GATE_JOB,
      `${AGGREGATE}/${GATE_JOB} declares \`name: ${JSON.stringify(aggregate.name)}\`, want `
      + `\`${GATE_JOB}\`. The check-run name is what branch protection matches. A job relying on `
      + `its key today is one rename away from reporting a context nothing requires, and an `
      + `un-required gate reports green by not being consulted.`,
    );
    need(
      aggregate.if === "always()",
      `${AGGREGATE}/${GATE_JOB} declares \`if: ${JSON.stringify(aggregate.if)}\`, want `
      + `\`always()\`. Without it the aggregate is SKIPPED the moment any lane fails — and a `
      + `skipped required context is an ABSENT one, so the merge box would show nothing rather `
      + `than red.`,
    );
    const needs = Array.isArray(aggregate.needs) ? aggregate.needs : [aggregate.needs];
    need(
      deepEqual(needs.slice().sort(), roster.slice().sort()),
      `${AGGREGATE}/${GATE_JOB} depends on [${needs.join(", ")}]; want exactly `
      + `[${roster.join(", ")}]. Both directions matter. A lane called above and absent from `
      + `\`needs:\` is invisible to the aggregate: it can fail while \`${GATE_JOB}\` reports `
      + `success, which is the fail-open state this workflow exists to replace. A lane in `
      + `\`needs:\` and no longer called can only ever be skipped.`,
    );
    const timeout = Number(aggregate["timeout-minutes"]);
    need(
      Number.isFinite(timeout) && timeout > 0 && timeout <= GATE_TIMEOUT_MAX,
      `${AGGREGATE}/${GATE_JOB}: timeout-minutes is `
      + `${JSON.stringify(aggregate["timeout-minutes"])}, want a finite number no greater than `
      + `${GATE_TIMEOUT_MAX}. Unbounded, the one job every merge waits on inherits GitHub's `
      + `six-hour default.`,
    );

    // The rule, read out of the step that enforces it.
    const text = runText(aggregate);
    const rosterOf = (name) => {
      const value = new RegExp(`^\\s*${name}='([^']*)'\\s*$`, "m").exec(text)?.[1];
      return value === undefined ? null : value.split(/\s+/).filter(Boolean);
    };
    const declaredConditional = rosterOf("CONDITIONAL_LANES");
    const declaredAlways = rosterOf("UNCONDITIONAL_LANES");
    need(
      declaredConditional !== null && deepEqual(declaredConditional.slice().sort(), lanes.slice().sort()),
      `${AGGREGATE}/${GATE_JOB}'s CONDITIONAL_LANES roster is `
      + `${JSON.stringify(declaredConditional)}; want [${lanes.join(", ")}]. The roster is a `
      + `hardcoded literal precisely so the aggregate fails on a missing key rather than `
      + `iterating whatever it was handed — which means something has to keep it equal to the `
      + `lanes, and this is it.`,
    );
    need(
      declaredAlways !== null && deepEqual(declaredAlways, GATE_ALWAYS),
      `${AGGREGATE}/${GATE_JOB}'s UNCONDITIONAL_LANES roster is `
      + `${JSON.stringify(declaredAlways)}; want [${GATE_ALWAYS.join(", ")}]. A lane moved out of `
      + `this roster stops being required to SUCCEED and starts being required to be SKIPPED — `
      + `the wrong direction, and silently.`,
    );

    const accepted = [...text.matchAll(/^\s*'([^']*)'\)\s*;;\s*$/gm)].map((m) => m[1]).sort();
    need(
      deepEqual(accepted, GATE_ACCEPTED),
      `${AGGREGATE}/${GATE_JOB} accepts the lane result pairings [${accepted.join(", ")}]; want `
      + `exactly [${GATE_ACCEPTED.join(", ")}]. This is the TWO-WAY rule, and a whitelist is not `
      + `a substitute for it: adding \`failure\` or \`cancelled\` makes a red lane green, and `
      + `accepting \`true:skipped\` passes a lane that WAS selected and then got skipped by a `
      + `broken condition — which is the exact fail-open shape this gate exists to close.`,
    );
    need(
      /toJSON\(needs\)/.test(JSON.stringify(aggregate))
        && /toJSON\(needs\.select\.outputs\)/.test(JSON.stringify(aggregate)),
      `${AGGREGATE}/${GATE_JOB} no longer reads \`toJSON(needs)\` and `
      + `\`toJSON(needs.select.outputs)\` into its environment. Those two blobs ARE the evidence `
      + `it judges; a step that stopped reading one of them is judging a constant.`,
    );
    need(
      /set -euo pipefail/.test(text),
      `${AGGREGATE}/${GATE_JOB} dropped \`set -euo pipefail\`. Its rule is a shell loop over jq `
      + `output, so an unset variable or a failed jq must abort rather than compare the empty `
      + `string against an expectation and pass.`,
    );
  }

  // -- and nothing else may carry the required name -------------------------
  const gateNameHosts = [...world.texts.keys()]
    .filter((file) => file !== AGGREGATE)
    .filter((file) => jobKeysOf(world, file).includes(GATE_JOB)
      || new RegExp(`^ {4}name: ${GATE_JOB}\\s*$`, "m").test(world.texts.get(file) ?? ""))
    .sort();
  need(
    gateNameHosts.length === 0,
    `[${gateNameHosts.join(", ")}] also declare a job named \`${GATE_JOB}\`. That is the aggregate `
    + `status context: a second job of this name in this repository is the SAME GitHub App posting `
    + `the SAME context, so an unrelated green lane can satisfy the requirement on behalf of a `
    + `gate that never ran — and it reports green, not missing. This is the one substitution the `
    + `\`app_id\` binding cannot stop, exactly as in 6j. Only ${AGGREGATE} may declare it.`,
  );

  return out;
}

// ── 6o. compat's single entry point, and the surface it may not grow back ──
//
// `compat.yml` was, for exactly one migration step, the only workflow in this
// repository a single pull request started TWICE: once through its own
// `pull_request:` trigger, and once as `merge-gate.yml`'s unconditional
// `compat` lane. Section 1 asserts the trigger shape that ended that and is now
// permanent — direct `pull_request:` absent, `workflow_call:` and `push: main`
// present. This section asserts what that shape LEFT BEHIND, which is a
// different property and is invisible to everything else here, actionlint
// included.
//
// Three of them, and each is one edit from coming back:
//
//   * NO `workflow_call` inputs, at all. The transitional `concurrency_scope`
//     input was a concurrency discriminator and nothing else — its only
//     consumer was the group below — and it went with the second entry point it
//     existed to tell apart. This file runs on every pull request in the
//     repository, so an input here is the widest behaviour switch it is
//     possible to add: a lever any caller can pull to make the always-on
//     compatibility gate check LESS when it is called than when it is not.
//     `merge-gate.yml` also calls it with no `with:` block at all, so a
//     REQUIRED input would additionally be a caller-side syntax error — the
//     entire gate run fails to load and `merge-gate` reports nothing rather
//     than red. Banning the whole surface covers both, and is the only form of
//     the rule that survives somebody re-adding an input under a new name.
//   * NO job reading `inputs.` anything, which is the same lever one level
//     down. `concurrency:` is evaluated before any job runs, so a value read
//     only there cannot gate work; a value read inside `jobs:` can.
//   * A concurrency group that is the literal prefix plus the repository-wide
//     suffix and carries no expression of its own. Section 2 asserts the exact
//     string; this asserts WHY it has that shape. An `inputs.` term reappearing
//     in the group is the discriminator returning, and a discriminator can only
//     be for telling apart an entry point that must not exist. A prefix equal
//     to `merge-gate.yml`'s own is the caller/callee DEADLOCK: GitHub holds the
//     callee's jobs behind the caller's, and the caller cannot finish until the
//     callee does, so the run hangs until it is cancelled by hand.
//
// The cancellation the discriminator used to prevent cannot recur while the
// trigger shape holds. Only the CALLED run is keyed by
// `github.event.pull_request.number` — inside a called workflow the event
// context is the caller's, and the caller's event is that `pull_request` — and
// `push` and `workflow_dispatch` key on `github.run_id`, which is unique per
// run and therefore collides with nothing, including with each other. That is a
// consequence of section 1's rules rather than of anything asserted here, which
// is why this section binds the residue instead of restating them.
function compatEntryPointFailures(world) {
  const out = [];
  const need = (ok, message) => { if (!ok) out.push(message); };

  // Non-vacuity, about this file's own constant rather than about the tree.
  // Every group rule below compares against it; an empty constant would make
  // `startsWith` true for any string at all, and an expression-valued one would
  // reintroduce exactly what the group must no longer contain.
  need(
    typeof COMPAT_GROUP_PREFIX === "string"
      && COMPAT_GROUP_PREFIX !== ""
      && !COMPAT_GROUP_PREFIX.includes("${{"),
    `this policy's own \`COMPAT_GROUP_PREFIX\` is ${JSON.stringify(COMPAT_GROUP_PREFIX)}. It must `
    + `be a NON-EMPTY LITERAL: the rules below compare the workflow's declared group against it, `
    + `so an empty constant would make them pass for any group at all and an expression-valued `
    + `one would assert back the very shape this section exists to keep out.`,
  );

  const doc = world.docs.get(COMPAT);
  need(
    doc !== undefined,
    `${COMPAT} is missing or did not parse, so nothing below is checked — including whether the `
    + `one gate no change in this repository can route around has grown a caller-controlled `
    + `behaviour switch.`,
  );
  if (!doc) return out;

  // -- the input surface, which must be empty -------------------------------
  const on = doc.on && typeof doc.on === "object" ? doc.on : {};
  const call = on.workflow_call && typeof on.workflow_call === "object" ? on.workflow_call : {};
  const declaredInputs = Object.keys(call.inputs ?? {});
  need(
    declaredInputs.length === 0,
    `${COMPAT}'s \`workflow_call\` declares inputs [${declaredInputs.join(", ")}]; want NONE. This `
    + `file runs on every pull request in the repository, through ${AGGREGATE}'s unconditional `
    + `call, so an input here is the widest behaviour switch it is possible to add — a lever a `
    + `caller can pull to make the always-on compatibility gate check less. The one input this `
    + `file ever had was a concurrency discriminator for a second entry point that no longer `
    + `exists. A REQUIRED one is worse still: ${AGGREGATE} passes no \`with:\` block, so the `
    + `ENTIRE gate run would fail to load and \`${GATE_JOB}\` would report nothing rather than red.`,
  );

  // The same lever one level down. Asserted separately from the declaration
  // above and deliberately: a job may read an input the CALLER declares nowhere
  // — it evaluates to the empty string — so a read inside `jobs:` is its own
  // regression even when `workflow_call` is clean.
  const jobsText = JSON.stringify(doc.jobs ?? {});
  const inputRead = /inputs[.\['"]+([A-Za-z0-9_-]*)/.exec(jobsText);
  need(
    inputRead === null,
    `${COMPAT}: a job reads \`inputs.${inputRead?.[1] ?? ""}\`. Nothing in \`jobs:\` may read an `
    + `input here. \`concurrency:\` is evaluated before any job runs, which is why a value read `
    + `only there cannot gate work — but a value read inside a job turns the caller's identity `
    + `into a BEHAVIOUR switch on the always-on compatibility gate, and that is exactly how a `
    + `gate acquires a way to check less when it is called than when it is not.`,
  );

  // -- the concurrency group, and the two shapes it must never take ---------
  const group = typeof doc.concurrency?.group === "string" ? doc.concurrency.group : "";
  need(
    group.startsWith(`${COMPAT_GROUP_PREFIX}-`),
    `${COMPAT}: concurrency.group is ${JSON.stringify(group)}, which does not start with the `
    + `literal prefix \`${COMPAT_GROUP_PREFIX}-\`. A called lane needs a literal nothing else `
    + `uses: inside a called workflow \`\${{ github.workflow }}\` is the CALLER's name, so `
    + `anything derived from it puts this file in ${AGGREGATE}'s own group — the callee queues `
    + `behind the caller that is waiting for it, and the run hangs until somebody cancels it.`,
  );
  need(
    !/inputs\s*[.\['"]/.test(group),
    `${COMPAT}: concurrency.group is ${JSON.stringify(group)} and reads an \`inputs.\` term `
    + `again. That is the call-vs-direct discriminator coming back, and a discriminator has `
    + `exactly one purpose: telling apart two entry points on one pull request. This file has `
    + `ONE — ${AGGREGATE}'s call — because protection now requires \`${GATE_JOB}\` alone and the `
    + `direct \`pull_request:\` trigger is gone. A term here is either dead weight on the group `
    + `or the second entry point being prepared; section 1 is what fails if it actually returns.`,
  );

  const gateGroup = typeof world.docs.get(AGGREGATE)?.concurrency?.group === "string"
    ? world.docs.get(AGGREGATE).concurrency.group
    : "";
  const prefixOf = (value) => (value.endsWith(`-${GROUP_SUFFIX}`)
    ? value.slice(0, -(GROUP_SUFFIX.length + 1))
    : value);
  const compatPrefix = prefixOf(group);
  const gatePrefix = prefixOf(gateGroup);
  need(
    compatPrefix === "" || gatePrefix === "" || compatPrefix !== gatePrefix,
    `${COMPAT} and ${AGGREGATE} share the concurrency prefix ${JSON.stringify(compatPrefix)}. `
    + `Caller and callee in one group is a DEADLOCK, not a cancellation: GitHub holds the `
    + `callee's jobs behind the caller's, and the caller cannot finish until the callee does. The `
    + `run hangs until it is cancelled by hand, and \`${GATE_JOB}\` reports nothing at all.`,
  );

  return out;
}

// ── 6p. the iOS lane builds with the toolchain Apple will accept ────────────
//
// Every other section here is about which lane runs and what it costs. This one
// is about whether the lane's green means anything, and it exists because a
// hosted iOS run was green against a toolchain no upload may use: `macos-15`'s
// default Xcode is 16.4, below Apple's Xcode 26 / iOS 26 SDK upload floor, and
// nothing in the run says so. `ios.yml`'s own `env:` block carries the full
// rationale; this section is the part of it that source can hold, asserted by
// mutation because each shape below leaves a perfectly valid, perfectly green
// workflow behind.
//
// The load-bearing claim is EXACT-MAJOR SELECTION, which is what keeps both the
// 16.4 default and the announced Xcode 27 PUBLIC PREVIEW out. The explicit-
// marker refusal is a cheap extra, not a prerelease detector, and nothing here
// claims otherwise.
//
// Nothing here signs, archives or uploads anything, and it must not grow to.
// App Store Connect read-back and TestFlight availability are separate gates,
// owned by `docs/ios-app-store-submission.md`.

/** The hosted image whose inventory this gate's Xcode claim is about. */
const IOS_RUNNER = "macos-15";

/**
 * The one Xcode major this lane may build with, and the iOS SDK floor.
 *
 * The Xcode number is REQUIRED rather than minimum: Apple rejects below 26, and
 * 27 is currently a public preview, so raising it is a decision made against a
 * demonstrated upload rather than an image inventory. The SDK number stays a
 * floor because Apple validates the SDK a binary was LINKED against.
 */
const REQUIRED_XCODE_MAJOR = 26;
const APPLE_MIN_IOS_SDK_MAJOR = 26;

const XCODE_MAJOR_KEY = "RELAYIUM_XCODE_MAJOR";
const SDK_MIN_KEY = "RELAYIUM_MIN_IOS_SDK_MAJOR";
const SELECT_KEY = "RELAYIUM_SELECT_XCODE";

/** The one form a job may run the selection in; three copies is the drift. */
const SELECT_REF = `\${{ env.${SELECT_KEY} }}`;
const SELECT_REF_RE = new RegExp(`\\$\\{\\{\\s*env\\.${SELECT_KEY}\\s*\\}\\}`);

/** Anything that compiles, tests or drives a simulator with the selected Xcode. */
const TOOLCHAIN_COMMAND = /\b(xcodebuild|xcrun|swift)\b/;

/** The script's executable lines: comments and blanks carry no behaviour. */
function scriptLines(script) {
  return String(script ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"));
}

/**
 * The local variable a script binds an environment key to, or null.
 *
 * Read rather than assumed so the checks below survive a rename: what matters
 * is that the declared number reaches a comparison, not how the shell variable
 * is spelled.
 */
function localBinding(lines, envKey) {
  const re = new RegExp(`^([A-Za-z_][A-Za-z0-9_]*)=.*\\$\\{?${envKey}\\b`);
  for (const line of lines) {
    const match = line.match(re);
    if (match) return match[1];
  }
  return null;
}

/**
 * Does a guard matching `condition` reach a statement matching `body`?
 *
 * The pairing is what every script check below is about: a script that tests and
 * carries on is not a gate, and a bare `exit`/`continue` with no test in front
 * of it is not this gate. Bounded to the eight lines after the guard and stopped
 * by the closing `fi` so a later block cannot satisfy an earlier condition.
 */
function guardLeadsTo(lines, condition, body) {
  for (let i = 0; i < lines.length; i += 1) {
    if (!condition.test(lines[i])) continue;
    for (let j = i + 1; j < lines.length && j <= i + 8; j += 1) {
      if (/^fi\b/.test(lines[j])) break;
      if (body.test(lines[j])) return true;
    }
  }
  return false;
}

function iosUploadToolchainFailures(world) {
  const out = [];
  const need = (ok, message) => { if (!ok) out.push(message); };

  const transferJob = world.docs.get(IOS_TRANSFER_INTEROP)?.jobs?.["ios-transfer-acceptance"];
  need(
    transferJob?.["runs-on"] === IOS_RUNNER,
    `${IOS_TRANSFER_INTEROP}/ios-transfer-acceptance: \`runs-on\` is `
    + `${JSON.stringify(transferJob?.["runs-on"])}, want ${JSON.stringify(IOS_RUNNER)}. The `
    + `acceptance selects Xcode from this image's inventory and that claim does not transfer `
    + `to another image implicitly.`,
  );

  const doc = world.docs.get(IOS);
  need(doc !== undefined, `${IOS} is missing or did not parse.`);
  if (!doc) return out;

  // ── the declared toolchain numbers ───────────────────────────────────────
  const env = doc.env;
  need(
    env !== undefined && env !== null && typeof env === "object",
    `${IOS} declares no workflow-level \`env:\` block. It is where this lane's required Xcode `
    + `major, its iOS SDK floor and its one shared selection script live; without it every job `
    + `falls back to the runner image's default Xcode, which is 16.4 on ${IOS_RUNNER} and produces `
    + `binaries Apple refuses at upload.`,
  );
  if (!env || typeof env !== "object") return out;

  const rawMajor = env[XCODE_MAJOR_KEY];
  need(
    Number.isInteger(Number(rawMajor)) && Number(rawMajor) === REQUIRED_XCODE_MAJOR,
    `${IOS}: \`env.${XCODE_MAJOR_KEY}\` is ${JSON.stringify(rawMajor)}, want exactly `
    + `${REQUIRED_XCODE_MAJOR}. BOTH directions off this number fail silently: 16 re-admits the `
    + `${IOS_RUNNER} default, below Apple's upload floor; 27 admits the public preview the image `
    + `carries, which is outside the major this lane certifies and is not evidence to submit an `
    + `App Store build on — not, on current guidance, a build TestFlight refuses. Either way it `
    + `still compiles and the lane stays green, so moving this belongs in the same commit as a `
    + `demonstrated accepted upload from the new major.`,
  );

  const rawSdk = env[SDK_MIN_KEY];
  need(
    Number.isInteger(Number(rawSdk)) && Number(rawSdk) >= APPLE_MIN_IOS_SDK_MAJOR,
    `${IOS}: \`env.${SDK_MIN_KEY}\` is ${JSON.stringify(rawSdk)}, want an integer of at least `
    + `${APPLE_MIN_IOS_SDK_MAJOR}. Lowering it is how the gate stops gating with no line deleted: `
    + `every step still runs and the comparison still passes.`,
  );

  // ── the one shared script ────────────────────────────────────────────────
  const script = env[SELECT_KEY];
  need(
    typeof script === "string" && script.trim() !== "",
    `${IOS}: \`env.${SELECT_KEY}\` is missing or empty. It is the whole mechanism: one selection `
    + `script the three jobs share, so a toolchain rule cannot be tightened in one job and left `
    + `behind in another.`,
  );
  const lines = scriptLines(script);
  need(lines.length > 0, `${IOS}: the shared selection script has no executable lines at all.`);

  if (lines.length > 0) {
    need(
      /^set\s+-euo\s+pipefail$/.test(lines[0]),
      `${IOS}: the shared selection script begins with ${JSON.stringify(lines[0])}, want `
      + `\`set -euo pipefail\`. Without \`-e\` a failed \`xcrun\` leaves an empty version string `
      + `the script walks on to compare.`,
    );
    need(
      lines.some((line) => /\/Applications\/Xcode\*\.app/.test(line)),
      `${IOS}: the shared selection script never enumerates \`/Applications/Xcode*.app\`. The `
      + `image rotates its Xcode point releases without any commit here, so naming one bundle path `
      + `turns the next refresh into an outage, and naming none takes the 16.4 default.`,
    );
    need(
      lines.some((line) => /DEVELOPER_DIR=.*>>\s*"?\$\{?GITHUB_ENV/.test(line)),
      `${IOS}: the shared selection script does not export \`DEVELOPER_DIR\` through `
      + `\`$GITHUB_ENV\`. Selecting a toolchain inside one step's shell changes nothing for the `
      + `steps after it: they still compile against the image default while the selection step `
      + `reports a correct version and passes.`,
    );

    // The explicit-marker refusal, scoped and not overclaimed: it drops a
    // bundle that ANNOUNCES itself as a seed in its path or version report.
    // Apple guarantees no such marker, so this catches some prereleases and not
    // others — the required-major filter below is what keeps the announced
    // Xcode 27 preview out. Asserted on the glob, not on printed prose, which
    // contains "beta" too and would survive the rule's deletion.
    //
    // Two markers are deliberately absent and must stay absent. A trailing
    // lowercase build letter is NOT a seed marker: stable Xcode 16.0 shipped as
    // `16A242d`. Nor is "release candidate": Apple's App Store Connect release
    // notes permitted Xcode 26.6 with the iOS 26.5 RC SDK for distribution.
    need(
      lines.some((line) => /\*beta\*/.test(line)),
      `${IOS}: the shared selection script carries no \`*beta*\` match, so a toolchain that `
      + `announces itself as a beta in its path or version report is a candidate like any other.`,
    );
    need(
      guardLeadsTo(lines, /^if\s+!?\s*[^;]*\bprerelease\b/, /^continue\b/),
      `${IOS}: the shared selection script never REFUSES a candidate carrying an explicit `
      + `prerelease marker — nothing tests one and drops it from the enumeration. Defining the `
      + `predicate is not the gate.`,
    );

    // ── the required major, as a filter inside the enumeration ────────────
    //
    // `!=` and `continue` are both load-bearing: a `-lt` guard accepts every
    // major above the required one — here, the Xcode 27 preview — and one that
    // exited would turn a merely uninteresting bundle into a lane outage. It
    // must sit INSIDE the enumeration, before a candidate can win.
    const xcodeVar = localBinding(lines, XCODE_MAJOR_KEY);
    need(
      xcodeVar !== null,
      `${IOS}: the shared selection script never reads \`${XCODE_MAJOR_KEY}\`, so the declared `
      + `required major reaches no comparison and the \`env:\` entry above is decoration.`,
    );
    const majorRe = new RegExp(`!=\\s+"?\\$\\{?${xcodeVar ?? "required"}\\b`);
    need(
      xcodeVar === null || guardLeadsTo(lines, majorRe, /^continue\b/),
      `${IOS}: the shared selection script never restricts selection to the required Xcode major `
      + `— no \`!= "$${xcodeVar ?? "required"}"\` test drops a candidate before it can be chosen. `
      + `Without it the enumeration is newest-wins, which fails BOTH ways: the ${IOS_RUNNER} `
      + `default when nothing newer is installed, and the Xcode 27 public preview the moment an `
      + `image refresh lands one. A \`-lt\` floor is not a substitute, which is why this asks for `
      + `an equality: "at least 26" is exactly the rule that selects 27.`,
    );
    need(
      xcodeVar === null || guardLeadsTo(lines, majorRe, /\bexit\s+[1-9]/),
      `${IOS}: the shared selection script never re-asserts the SELECTED major after the loop. `
      + `The filter keeps a wrong major from winning; this exit catches a future edit that lets `
      + `one through anyway — the difference between dying here and shipping.`,
    );
    need(
      guardLeadsTo(lines, /-z\s+"?\$\{?selected/, /\bexit\s+[1-9]/),
      `${IOS}: the shared selection script does not fail closed on an empty selection. Filtering `
      + `to one required major means the enumeration can legitimately end with no candidate, and `
      + `that has to be a non-zero exit. Walking past it exports an empty \`DEVELOPER_DIR\`, which `
      + `is not an error downstream: it silently means the runner default, i.e. Xcode 16.4.`,
    );

    // ── the SDK floor, read and enforced ──────────────────────────────────
    need(
      lines.some((line) => /xcrun\s+--sdk\s+iphoneos\s+--show-sdk-version/.test(line)),
      `${IOS}: the shared selection script never reads the iphoneos SDK version `
      + `(\`xcrun --sdk iphoneos --show-sdk-version\`). Apple validates the SDK a binary was `
      + `LINKED against — a different fact from the Xcode version, and it can be older.`,
    );
    const sdkVar = localBinding(lines, SDK_MIN_KEY);
    need(
      sdkVar !== null,
      `${IOS}: the shared selection script never reads \`${SDK_MIN_KEY}\`, so the declared iOS `
      + `SDK minimum reaches no comparison at all.`,
    );
    need(
      sdkVar === null
        || guardLeadsTo(lines, new RegExp(`-lt\\s+"?\\$\\{?${sdkVar}\\b`), /\bexit\s+[1-9]/),
      `${IOS}: the shared selection script never compares the iphoneos SDK against `
      + `\`${SDK_MIN_KEY}\` and exits non-zero. The Xcode check does not stand in for it: an `
      + `Xcode 26 with its iOS 26 SDK replaced satisfies one and fails the upload on the other.`,
    );
  }

  // ── every job runs it, first, and nothing puts the old toolchain back ────
  const jobs = Object.entries(doc.jobs ?? {});
  need(jobs.length > 0, `${IOS} declares no jobs, so every per-job check below inspects nothing.`);
  for (const [name, job] of jobs) {
    need(
      job?.["runs-on"] === IOS_RUNNER,
      `${IOS}/${name}: \`runs-on\` is ${JSON.stringify(job?.["runs-on"])}, want `
      + `${JSON.stringify(IOS_RUNNER)}. This section is a claim about what that image has `
      + `installed — an Xcode 26 beside the 16.4 default — and it does not travel to another `
      + `image on its own. Make that decision here, against the new image's inventory.`,
    );

    const steps = job?.steps ?? [];
    const guardIndices = steps
      .map((step, index) => ({ step, index }))
      .filter(({ step }) => SELECT_REF_RE.test(String(step?.run ?? "")))
      .map(({ index }) => index);
    const guardIndex = guardIndices[0] ?? -1;
    need(
      guardIndex !== -1,
      `${IOS}/${name}: no step runs the shared Xcode selection \`${SELECT_REF}\`. Every job here `
      + `compiles or drives the app, so a job that skips it builds with ${IOS_RUNNER}'s default `
      + `Xcode 16.4 while the others report the toolchain is fine — two thirds of the lane `
      + `standing as evidence for a toolchain the third did not use.`,
    );
    if (guardIndex === -1) continue;
    // One selection per job. Two make "which one governs the build" a matter of
    // reading order, and the checks below would answer it about the first.
    need(
      guardIndices.length === 1,
      `${IOS}/${name}: ${guardIndices.length} steps run the shared Xcode selection `
      + `(indices ${guardIndices.join(", ")}). Selection happens once per job; with two, the `
      + `ordering and shape checks here describe the first while the build inherits whatever `
      + `the last one exported.`,
    );

    // ── the selection step is the shared script, whole, and can report red ──
    //
    // Containing the reference is not running it. `run: ${{ env.… }} || true`,
    // a `continue-on-error`, or an `if` that is false all leave a step that
    // still MATCHES the reference above while the fail-closed exits inside the
    // script reach nothing: the job goes green, and the build below it compiles
    // against the image's default Xcode 16.4. The shared script is a whole
    // command by construction, so the exact form is the check.
    const guard = steps[guardIndex];
    const guardRun = String(guard?.run ?? "").trim();
    need(
      guardRun === SELECT_REF,
      `${IOS}/${name}: the Xcode selection step runs ${JSON.stringify(guardRun)}, want exactly `
      + `\`${SELECT_REF}\`. Anything wrapped around the shared script — \`|| true\`, a trailing `
      + `\`exit 0\`, a subshell whose status is dropped — swallows the fail-closed exits the `
      + `script's whole purpose is to reach, and the job stays green on the toolchain it was `
      + `written to refuse.`,
    );
    // Absent or literally `false` — nothing else. GitHub honours the quoted
    // string `'true'` and an `${{ }}` expression here just as it honours the
    // boolean, so "not the boolean true" is not the fail-closed reading.
    for (const [scope, value] of [
      ["step", guard?.["continue-on-error"]],
      ["job", job?.["continue-on-error"]],
    ]) {
      need(
        value === undefined || value === false,
        `${IOS}/${name}: the Xcode selection ${scope} sets `
        + `\`continue-on-error: ${JSON.stringify(value)}\`. A refused toolchain then reports green `
        + `and the steps after it still build — with the \`DEVELOPER_DIR\` the selection never got `
        + `far enough to export. Absent or \`false\`; a quoted \`'true'\` and an \`${"${{ }}"}\` `
        + `expression are honoured here too.`,
      );
    }
    need(
      guard?.if === undefined,
      `${IOS}/${name}: the Xcode selection step carries \`if: ${guard?.if}\`. A skipped step does `
      + `not report red, it reports nothing, and the build steps below it are not conditional — `
      + `so the lane goes green having compiled against ${IOS_RUNNER}'s default Xcode 16.4.`,
    );

    const work = steps
      .map((step, index) => ({ step, index }))
      .filter(({ step, index }) => index !== guardIndex
        && TOOLCHAIN_COMMAND.test(String(step?.run ?? "")));
    need(
      work.length > 0,
      `${IOS}/${name}: no step runs \`xcodebuild\`, \`xcrun\` or \`swift\` at all, so the ordering `
      + `check below passes by having nothing to order against.`,
    );
    for (const { step, index } of work) {
      need(
        index > guardIndex,
        `${IOS}/${name}: the Xcode selection step runs AFTER `
        + `${JSON.stringify(step?.name ?? step?.uses ?? `step ${index}`)}. \`DEVELOPER_DIR\` `
        + `exported through \`$GITHUB_ENV\` reaches SUBSEQUENT steps only, so everything above `
        + `the selection compiles against the image default — silently, because the selection `
        + `still succeeds afterwards and the job goes green.`,
      );
    }

    // Nothing after the gate may put the old toolchain back. A YAML `env:` wins
    // over the value the selection exported, and a later `xcode-select` is a
    // second selection that no floor is enforced at.
    for (const scope of [
      { where: `${IOS}/${name}`, env: job?.env },
      ...steps.map((step, index) => ({
        where: `${IOS}/${name}, step `
          + `${JSON.stringify(step?.name ?? step?.uses ?? `step ${index}`)}`,
        env: step?.env,
      })),
    ]) {
      if (!scope.env || typeof scope.env !== "object") continue;
      for (const key of ["DEVELOPER_DIR", XCODE_MAJOR_KEY, SDK_MIN_KEY]) {
        need(
          scope.env[key] === undefined,
          `${scope.where} overrides \`${key}\` with ${JSON.stringify(scope.env[key])}. A YAML `
          + `\`env:\` wins over what the selection step exported, so the gate keeps passing while `
          + `the build it governs uses a different toolchain — or moves a floor to where nobody `
          + `reads it while the workflow-level number stays reassuringly correct.`,
        );
      }
    }
    const reselect = steps.find((step, index) => index !== guardIndex
      && /\bxcode-select\b/.test(String(step?.run ?? "")));
    need(
      reselect === undefined,
      `${IOS}/${name}: step ${JSON.stringify(reselect?.name ?? "")} runs \`xcode-select\`. `
      + `Selection happens once, in the shared script, where both floors are enforced; a second `
      + `selection anywhere else is unchecked by construction.`,
    );
  }

  return out;
}

for (const message of triggerFailures(realWorld())) failures.push(message);
for (const message of platformBoundaryFailures(realWorld())) failures.push(message);
for (const message of pathMatrixFailures(realWorld())) failures.push(message);
for (const message of fuzzCampaignFailures(realWorld())) failures.push(message);
for (const message of iosParallelLaneFailures(realWorld())) failures.push(message);
for (const message of appGuardCoverageFailures(realWorld())) failures.push(message);
for (const message of iosRegularWidthShellFailures(realWorld())) failures.push(message);
for (const message of iosCompactShardFailures(realWorld())) failures.push(message);
for (const message of macosBudgetFailures(realWorld())) failures.push(message);
for (const message of macosContractRunnerFailures(realWorld())) failures.push(message);
for (const message of concurrencyFailures(realWorld())) failures.push(message);
for (const message of releaseBoundaryFailures(realWorld())) failures.push(message);
for (const message of aggregateGateFailures(realWorld())) failures.push(message);
for (const message of compatEntryPointFailures(realWorld())) failures.push(message);
for (const message of iosUploadToolchainFailures(realWorld())) failures.push(message);

// ── 7h. the inventory script's own fail-closed proof, actually executed ─────
//
// Everything above reads the campaign's YAML. None of it can say whether
// `scripts/list-go-fuzz-targets.sh` still FAILS on the shape it promises to
// reject, and that script's id-collision guard is unfalsifiable against this
// repository: no two packages in `server/` flatten to one matrix id, so the
// guard has never been observed to fail and is indistinguishable from a broken
// one. Section 7g's artifact-name check rests entirely on it — `matrix.id` is
// only safe to name an artifact by because that guard proves it unique.
//
// The script answers this itself with `--self-test`: it runs its own `--json`
// form as a child process against a fake `go` that replies from a fixture, so
// it compiles nothing, reads no Go source, needs no toolchain and finishes in
// well under a second. That is not a fuzz run and does not belong on a
// schedule, and it must not sit in `go.yml` either — that lane is path-filtered
// to `server/**` and friends, so the proof would be absent from most commits.
// Here it runs in the always-on repo-hygiene lane, on every pull request and
// every `main` push, next to the YAML assertions it backs.
//
// Shelling out from a policy test has exactly one failure mode worth designing
// against: a harness that reports green whatever the child did. So the exit
// status is the only thing consulted, it is reported verbatim, and the call
// below is proved to propagate a nonzero one.

/**
 * Runs `scripts/list-go-fuzz-targets.sh` with `args` and returns complaints
 * about how it exited — nothing about what it printed, which is the script's
 * own business and is reproduced here only as diagnostics.
 *
 * The script and the working directory are both resolved from `repoRoot`, not
 * from `process.cwd()`: this file is run from the repository root in CI and
 * from a `scripts/` shell by hand, and a relative spawn would turn the second
 * into a confusing ENOENT.
 *
 * Bounded three ways, because a hung child here would hold the repo-hygiene
 * lane to its 10-minute job timeout and report as an infrastructure fault: no
 * inherited stdin, a wall-clock `timeout` far above the sub-second run it
 * expects, and a finite `maxBuffer`.
 */
function inventoryScriptFailures(args) {
  const out = [];
  const label = `${FUZZ_INVENTORY} ${args.join(" ")}`;
  const run = spawnSync(resolve(repoRoot, FUZZ_INVENTORY), args, {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 120_000,
    maxBuffer: 8 * 1024 * 1024,
  });

  if (run.error) {
    out.push(
      `\`${label}\` could not be executed: ${run.error.message}. It is the fail-closed proof `
      + `behind section 7's \`matrix.id\` assertion, and a script that cannot be run proves `
      + `nothing — an unreadable or non-executable file must fail here rather than be skipped.`,
    );
    return out;
  }

  const diagnostics = [run.stdout, run.stderr]
    .map((stream) => String(stream ?? "").trimEnd())
    .filter(Boolean)
    .join("\n")
    .split("\n")
    .map((line) => `      ${line}`)
    .join("\n") || "      (no output)";

  if (run.signal) {
    out.push(
      `\`${label}\` was killed by ${run.signal} rather than exiting. It compiles nothing and `
      + `finishes in well under a second, so reaching the harness timeout means it is hung or `
      + `waiting on input, not slow. Its output so far:\n${diagnostics}`,
    );
    return out;
  }

  if (run.status !== 0) {
    out.push(
      `\`${label}\` exited ${run.status}. That script's own checks are what make section 7's `
      + `\`matrix.id\` artifact name safe, and \`--self-test\` fails only if a fail-closed `
      + `check stopped failing closed — including the id-collision guard this repository cannot `
      + `otherwise falsify. Its output:\n${diagnostics}`,
    );
  }
  return out;
}

for (const message of inventoryScriptFailures(["--self-test"])) failures.push(message);

// The proof that the call above propagates a failure instead of reporting the
// child's exit status as green — the one thing that would make it a check that
// cannot fail, and the reason it takes its arguments rather than hard-coding
// them. The script rejects an unknown argument with status 2, which costs one
// argv comparison, touches nothing and needs no fixture; any other nonzero exit
// would do, and this is the cheapest one that is guaranteed not to depend on
// the state of the module.
{
  const probe = "--not-a-flag";
  const got = inventoryScriptFailures([probe]);
  check(
    got.some((message) => message.includes(`${probe}\` exited 2.`)),
    `running \`${FUZZ_INVENTORY} ${probe}\` — which that script rejects with status 2 — `
    + `produced ${got.length === 0 ? "no complaint" : JSON.stringify(got)}, so the harness that `
    + `runs \`--self-test\` above does not propagate a nonzero exit. Every self-test failure `
    + `would then report as a green policy run, which is worse than not running it at all.`,
  );
}

// ── 7i. the lane selector's own fail-closed proof, actually executed ────────
//
// Section 6n reads `merge-gate.yml`. None of it can say whether
// `scripts/ci/select-lanes.mjs` still FAILS CLOSED on the shapes it promises to
// reject, and those branches are the least falsifiable code in this repository:
// a files-API error, a 3000-file change set, a truncated response, an
// unreadable lane filter. Each selects EVERY conditional lane, each has never
// been observed happening, and a fail-closed branch nobody has seen fail is
// indistinguishable from a broken one.
//
// The script answers this itself with `--self-test`, exactly as
// `scripts/list-go-fuzz-targets.sh` does above: it drives its own reader,
// vocabulary, matcher and every fail-closed condition in process, compiles
// nothing, reads no network and finishes in well under a second.
//
// The direction that matters is UNDER-selection. Over-selection costs runner
// minutes on a documentation edit; under-selection is a GREEN required gate
// over code no lane compiled, arriving through the gate that exists to prevent
// exactly that.
//
// Shelling out has one failure mode worth designing against — a harness that
// reports green whatever the child did — so the exit status is the only thing
// consulted, and the call is proved below to propagate a nonzero one.

/**
 * Runs `scripts/ci/select-lanes.mjs` with `args` and returns complaints about
 * how it exited. Bounded the same three ways as `inventoryScriptFailures`: no
 * inherited stdin, a wall-clock timeout far above the sub-second run it
 * expects, and a finite `maxBuffer`.
 */
function selectorScriptFailures(args) {
  const out = [];
  const label = `${SELECTOR} ${args.join(" ")}`;
  const run = spawnSync(process.execPath, [resolve(repoRoot, SELECTOR), ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 120_000,
    maxBuffer: 8 * 1024 * 1024,
  });

  if (run.error) {
    out.push(
      `\`${label}\` could not be executed: ${run.error.message}. It is the script the merge gate `
      + `runs to decide which lanes to call at all, and a script that cannot be run proves `
      + `nothing — an unreadable or moved file must fail here rather than be skipped.`,
    );
    return out;
  }

  const diagnostics = [run.stdout, run.stderr]
    .map((stream) => String(stream ?? "").trimEnd())
    .filter(Boolean)
    .join("\n")
    .split("\n")
    .map((line) => `      ${line}`)
    .join("\n") || "      (no output)";

  if (run.signal) {
    out.push(
      `\`${label}\` was killed by ${run.signal} rather than exiting. It parses a handful of small `
      + `YAML filters and finishes in well under a second, so reaching the harness timeout means `
      + `it is hung, not slow — and a hung selector holds the job every merge waits on. Its `
      + `output so far:\n${diagnostics}`,
    );
    return out;
  }

  if (run.status !== 0) {
    out.push(
      `\`${label}\` exited ${run.status}. That self-test is what proves the selector's `
      + `fail-closed branches still fail closed and that its pattern vocabulary still refuses a `
      + `shape it cannot compile. Its output:\n${diagnostics}`,
    );
  }
  return out;
}

for (const message of selectorScriptFailures(["--self-test"])) failures.push(message);

// The proof that the call above propagates a failure instead of reporting the
// child's exit status as green. The script rejects an unknown argument with
// status 2, which costs one argv comparison and needs no fixture.
{
  const probe = "--not-a-flag";
  const got = selectorScriptFailures([probe]);
  check(
    got.some((message) => message.includes(`${probe}\` exited 2.`)),
    `running \`${SELECTOR} ${probe}\` — which that script rejects with status 2 — produced `
    + `${got.length === 0 ? "no complaint" : JSON.stringify(got)}, so the harness that runs `
    + `\`--self-test\` above does not propagate a nonzero exit. Every self-test failure would `
    + `then report as a green policy run, which is worse than not running it at all.`,
  );
}

// And the suite that judges the selector against the SHARED fixture is itself
// hosted where nothing can filter it away. Section 6h states the same rule for
// this file; the reason is identical and the failure is worse, because the
// selector decides whether the expensive lanes run at all.
{
  const hygiene = docs.get(SELF_HOST);
  const hosts = Object.entries(hygiene?.jobs ?? {})
    .filter(([, job]) => realRunLines(job).some((line) => line.includes(`node ${SELECTOR_TEST}`)));
  check(
    hosts.length === 1,
    `${hosts.length} job(s) in ${SELF_HOST} run \`node ${SELECTOR_TEST}\`; want exactly one. That `
    + `suite is what judges ${SELECTOR} against the shared path-selection fixture — the same `
    + `oracle section 5g uses — so without it the two implementations stop being cross-validated `
    + `and the gate's lane selection is checked by nothing.`,
  );
  for (const [name, job] of hosts) {
    const timeout = Number(job["timeout-minutes"]);
    check(
      Number.isFinite(timeout) && timeout > 0 && timeout <= SELF_TIMEOUT_MAX,
      `${SELF_HOST}/${name}: timeout-minutes is ${JSON.stringify(job["timeout-minutes"])}, want a `
      + `finite number no greater than ${SELF_TIMEOUT_MAX}.`,
    );
    check(
      job.if === undefined && job["continue-on-error"] === undefined,
      `${SELF_HOST}/${name}: a job-level "if:" or continue-on-error lets the suite that judges `
      + `the merge gate's lane selection skip itself or report green after failing.`,
    );
  }
}

// ── 8. the proof that sections 5g, 6 and 7 can fail ─────────────────────────
//
// Every check above reads a world instead of module state precisely so this can
// exist. Each case below breaks ONE property in a copy of the real workflows and
// requires the matching complaint by its own wording — not merely "something
// failed", which a broken parser or an unrelated typo would also satisfy.
//
// All three world-driven check sets run against each mutated world: the
// platform boundary, the trigger matrix and the fuzz campaign. A mutation is free to disturb rows it was
// not written for — the assertion is that the named complaint is PRESENT, never
// that it is alone — and a trigger-matrix row is only worth having once some
// mutation has actually made it fail.
//
// This is the guard against the most expensive outcome available here: a policy
// file that passes because it is asserting nothing.

/** Set a workflow's push and pull_request filters together, the way the anchor does. */
function withPaths(world, file, paths) {
  const on = world.docs.get(file).on;
  on.push.paths = paths;
  on.pull_request = { ...(on.pull_request ?? {}), paths };
  return world;
}

/**
 * Remove exactly one entry from a workflow's shared filter.
 *
 * Derived from the world rather than restated as a replacement list, so it
 * removes ONE thing however the filter grows later, and throws when the entry
 * is already gone — the same discipline as `withCommandJob`. A mutation that
 * quietly stopped removing anything would leave the world unbroken, and the
 * case below it would pass while asserting nothing.
 */
function withoutPath(world, file, path) {
  const paths = wPaths(world, file);
  if (paths === null || !paths.includes(path)) {
    throw new Error(`${file}'s path filter does not list ${path}, so there is nothing to remove`);
  }
  return withPaths(world, file, paths.filter((entry) => entry !== path));
}

/**
 * Remove one trigger from a workflow, and throw when it is already gone.
 *
 * Throwing is the point, and it is the same discipline as `withoutPath`: a
 * mutation that silently stopped applying leaves the world unbroken, and the
 * case below it then passes while asserting nothing about the rule it names.
 */
function withoutTrigger(world, file, event) {
  const on = world.docs.get(file)?.on;
  if (!on || !(event in on)) {
    throw new Error(`${file} does not declare an \`${event}\` trigger, so there is nothing to remove`);
  }
  delete on[event];
  return world;
}

/** Give a workflow back a trigger it deliberately no longer has. */
function withTrigger(world, file, event, value = null) {
  const on = world.docs.get(file)?.on;
  if (!on) throw new Error(`${file} has no \`on:\` mapping to add \`${event}\` to`);
  if (event in on) throw new Error(`${file} already declares \`${event}\``);
  on[event] = value;
  return world;
}

/**
 * Mutate one job of `merge-gate.yml`, and throw when it is not there.
 *
 * By name rather than by position, for the reason `withNamedJob` gives: the
 * gate has twelve jobs and every case below names the one it breaks, so a
 * positional selector would silently retarget the day two YAML keys are
 * reordered.
 */
function withGateJob(world, name, mutate) {
  const job = world.docs.get(AGGREGATE)?.jobs?.[name];
  if (job === undefined) throw new Error(`${AGGREGATE} declares no job named ${name}`);
  mutate(job);
  return world;
}

/** Rewrite the aggregate step's shell, and require the anchor to still exist. */
function withGateRule(world, from, to) {
  const job = world.docs.get(AGGREGATE)?.jobs?.[GATE_JOB];
  const step = (job?.steps ?? []).find((s) => String(s?.run ?? "").includes("CONDITIONAL_LANES"));
  if (step === undefined) {
    throw new Error(`${AGGREGATE}/${GATE_JOB} has no step declaring CONDITIONAL_LANES to mutate`);
  }
  if (!step.run.includes(from)) {
    throw new Error(`${AGGREGATE}/${GATE_JOB}'s rule does not contain ${JSON.stringify(from)}`);
  }
  step.run = step.run.replace(from, to);
  return world;
}

/** Mutate the first job of a workflow. */
function withJob(world, file, mutate) {
  const jobs = world.docs.get(file).jobs;
  mutate(jobs[Object.keys(jobs)[0]]);
  return world;
}

/**
 * Mutate the job called `name`, and throw when the file does not declare it.
 *
 * `withJob` above selects POSITIONALLY, which is safe only while the file has
 * one job. `macos.yml` has six, and every case below names the one it breaks in
 * its own expectation — so selecting by position would silently retarget the
 * day somebody reorders two YAML keys, and the case would then pass while
 * asserting nothing about the job it claims to be about. Throwing on an absent
 * name is the point: a mutation that stopped applying must be a loud error, not
 * a green case.
 */
function withNamedJob(world, file, name, mutate) {
  const job = world.docs.get(file)?.jobs?.[name];
  if (job === undefined) throw new Error(`${file} declares no job named ${name}`);
  mutate(job);
  return world;
}

/**
 * Mutate the job in `file` that runs `command`, and the step carrying it.
 *
 * Throwing when no such job exists is deliberate: a mutation that silently
 * stopped applying would leave the world unbroken, and the case below it would
 * pass by asserting nothing — the failure this whole section exists to prevent.
 */
function withCommandJob(world, file, command, mutate) {
  for (const [name, job] of Object.entries(world.docs.get(file)?.jobs ?? {})) {
    const step = (job.steps ?? []).find((s) => String(s?.run ?? "").includes(command));
    if (step) { mutate(job, step, name); return world; }
  }
  throw new Error(`no job in ${file} runs ${command}`);
}

/**
 * Mutate the dependency-install step of `compat.yml`'s gate job.
 *
 * Throws for the same reason `withCommandJob` does, and it is not hypothetical:
 * while this helper was being written, deleting the install step from the real
 * workflow made the cases below die with `Cannot set properties of undefined`.
 * That is a legible-enough failure only by accident. Naming it means a future
 * reader learns which step vanished instead of which property was undefined.
 */
function withInstallStep(world, mutate) {
  for (const [name, job] of Object.entries(world.docs.get(COMPAT)?.jobs ?? {})) {
    const steps = job.steps ?? [];
    const at = steps.findIndex((step) => VECTOR_INSTALL.test(String(step?.run ?? "")));
    if (at !== -1) { mutate(steps[at], job, at, name); return world; }
  }
  throw new Error(
    `no job in ${COMPAT} has an \`npm ci\` step to mutate. The dependency install this case exists `
    + `to protect is already gone, so the case cannot prove anything about it.`,
  );
}

/** A plausible future platform workflow, as the parser would have produced it. */
function syntheticPlatform({ workflow, root, run, timeout = "30" }) {
  return {
    name: workflow.replace(/\.ya?ml$/, ""),
    on: {
      push: { branches: ["main"], paths: [`${root}/**`, `.github/workflows/${workflow}`] },
      pull_request: { paths: [`${root}/**`, `.github/workflows/${workflow}`] },
      workflow_dispatch: null,
    },
    concurrency: { group: GROUP, "cancel-in-progress": CANCEL },
    jobs: {
      build: {
        "runs-on": "ubuntu-latest",
        "timeout-minutes": timeout,
        steps: [
          { uses: "actions/checkout@de0fac2e4500dabe0009e67214ff5f5447ce83dd" },
          { name: "Build", run: `${run}\n` },
        ],
      },
    },
  };
}

/** Add a workflow to a world as if it were on disk and governed. */
function addWorkflow(world, file, doc) {
  world.docs.set(file, doc);
  world.texts.set(file, JSON.stringify(doc));
  // Replace, don't append. Once a future platform becomes a REAL one its file
  // is already governed, and pushing a second entry made the same workflow
  // appear twice in every roster the mutation cases print — which reads as a
  // duplicate-lane bug that is not there.
  const existing = world.governed.findIndex((entry) => entry.file === file);
  if (existing === -1) world.governed.push({ file, dispatch: true });
  else world.governed[existing] = { file, dispatch: true };
  return world;
}

/** Remove a workflow from the world, for the "one half was deleted" cases. */
function removeWorkflow(world, file) {
  world.docs.delete(file);
  world.texts.delete(file);
  world.governed = world.governed.filter((entry) => entry.file !== file);
  return world;
}

/** The remaining FUTURE platform, for the placeholder-shape cases; and the
 *  real Android owner, for the adopted-root cases. Android used to be the
 *  synthetic subject of the future-platform mutations below; when it became a
 *  real platform those cases moved to Windows so they keep exercising the
 *  future-platform branch, and Android gained REAL-file mutations instead. */
const WINDOWS = FUTURE_PLATFORMS.find((future) => future.root === "apps/windows");
const ANDROID_OWNER = PLATFORM_OWNERS.find((platform) => platform.root === "apps/android");

/** A governed workflow that is parsed, and a real one that deliberately is not. */
const WEB = "web.yml";
const CONTRACTS = "contracts.yml";
const OPS_DEPLOY_CONTRACT = "ops-deploy-contract.yml";
const AUTO_RELEASE = "auto-release.yml";

/**
 * Mutate the shared iOS selection script, and refuse to be a no-op.
 *
 * A mutation that silently stopped applying — the script rewritten, the pattern
 * no longer matching — would leave the world unbroken and let its case pass
 * while asserting nothing, which is what section 8 exists to prevent.
 */
function withIosScript(world, transform) {
  const env = world.docs.get(IOS)?.env;
  if (!env || typeof env !== "object") throw new Error(`${IOS} declares no workflow-level env`);
  const before = String(env[SELECT_KEY] ?? "");
  const after = transform(before);
  if (after === before) {
    throw new Error(
      `the mutation left ${IOS}'s \`${SELECT_KEY}\` unchanged, so the case below it would judge `
      + `the real script. Follow the script's rewrite here.`,
    );
  }
  env[SELECT_KEY] = after;
  return world;
}

/** Remove the whole `if … fi` block whose condition matches `re`. */
function withoutIosScriptBlock(world, re, label) {
  return withIosScript(world, (script) => {
    const lines = script.split("\n");
    const at = lines.findIndex((line) => re.test(line));
    if (at === -1) throw new Error(`${IOS}'s selection script has no ${label} condition to remove`);
    const indent = lines[at].length - lines[at].trimStart().length;
    let end = at + 1;
    while (end < lines.length
      && !(lines[end].trim() === "fi" && lines[end].length - lines[end].trimStart().length === indent)) {
      end += 1;
    }
    if (end >= lines.length) throw new Error(`${IOS}'s ${label} block is unterminated`);
    lines.splice(at, end - at + 1);
    return lines.join("\n");
  });
}

/** Mutate the step list of an iOS job around the index its selection step sits at. */
function withIosGuard(world, name, mutate) {
  const job = world.docs.get(IOS)?.jobs?.[name];
  if (job === undefined) throw new Error(`${IOS} declares no job named ${name}`);
  const steps = job.steps ?? [];
  const at = steps.findIndex((step) => SELECT_REF_RE.test(String(step?.run ?? "")));
  if (at === -1) throw new Error(`${IOS}/${name} already runs no shared Xcode selection step`);
  mutate(steps, at);
  return world;
}

/** Mutate the run body of `ios.yml`'s iPhone UI test step. */
function withIosUiSmokeRun(world, edit) {
  const step = world.docs.get(IOS)?.jobs?.[IOS_COMPACT_JOB]?.steps?.find((entry) => entry?.id === "ui_smoke");
  if (step === undefined) throw new Error(`${IOS}/${IOS_COMPACT_JOB} has no ui_smoke step`);
  const before = String(step.run);
  step.run = edit(before);
  if (step.run === before) throw new Error(`${IOS}/${IOS_COMPACT_JOB}: the ui_smoke mutation did not apply`);
  return world;
}

const MUTATIONS = [
  {
    name: "native-web-pairing.yml regains a bare `apps/**` filter",
    mutate: (world) => withPaths(world, NWP, [
      "apps/**", "web/**", "server/**", `.github/workflows/${NWP}`,
    ]),
    expect: /native-web-pairing\.yml triggers on apps\/ios/,
  },
  {
    name: "a governed workflow regains a bare `scripts/**` filter",
    mutate: (world) => withPaths(world, IOS, [
      "apps/ios/**", "apps/RelayiumKit/**", "scripts/**", `.github/workflows/${IOS}`,
    ]),
    expect: /ios\.yml's path filter lists the bare glob `scripts\/\*\*`/,
  },
  {
    name: "macos.yml adopts apps/ios, re-welding the two Apple platforms",
    mutate: (world) => withPaths(world, MACOS, [
      "apps/mac/**", "apps/ios/**", "apps/RelayiumKit/**", `.github/workflows/${MACOS}`,
    ]),
    expect: /platform root apps\/ios also starts macos\.yml/,
  },
  {
    name: "ios.yml stops watching the Apple-shared package",
    mutate: (world) => withPaths(world, IOS, [
      "apps/ios/**", `.github/workflows/${IOS}`,
    ]),
    expect: /apps\/RelayiumKit fans out to \[macos\.yml\]/,
  },
  // Both directions of the together-or-not-at-all rule. These used to ADD one
  // half, because `apps/windows/` and `windows.yml` did not exist; they were
  // created in the same commit, exactly as the rule requires, so the mutation
  // that proves the rule can still fail is now to DELETE one half.
  {
    name: "windows.yml is deleted while apps/windows remains",
    mutate: (world) => removeWorkflow(world, WINDOWS.workflow),
    expect: /apps\/windows\/ exists but \.github\/workflows\/windows\.yml does not/,
  },
  {
    name: "apps/windows is deleted while windows.yml remains",
    mutate: (world) => { world.roots.delete(WINDOWS.root); return world; },
    expect: /windows\.yml exists but apps\/windows\/ does not/,
  },
  {
    name: "windows.yml and apps/windows both exist, but the job only echoes",
    mutate: (world) => {
      world.roots.add(WINDOWS.root);
      return addWorkflow(world, WINDOWS.workflow, syntheticPlatform({
        workflow: WINDOWS.workflow, root: WINDOWS.root, run: 'echo "windows build: TODO"',
      }));
    },
    expect: /windows\.yml has no job that actually builds or tests apps\/windows/,
  },
  {
    name: "windows.yml exists but its filter names the wrong root",
    mutate: (world) => {
      world.roots.add(WINDOWS.root);
      addWorkflow(world, WINDOWS.workflow, syntheticPlatform({
        workflow: WINDOWS.workflow, root: WINDOWS.root, run: "dotnet build apps/windows",
      }));
      return withPaths(world, WINDOWS.workflow, [
        "apps/mac/**", `.github/workflows/${WINDOWS.workflow}`,
      ]);
    },
    expect: /windows\.yml does not trigger on its own root apps\/windows/,
  },
  {
    name: "windows.yml claims the Apple-shared package as cross-platform",
    mutate: (world) => {
      world.roots.add(WINDOWS.root);
      addWorkflow(world, WINDOWS.workflow, syntheticPlatform({
        workflow: WINDOWS.workflow, root: WINDOWS.root, run: "dotnet build apps/windows",
      }));
      return withPaths(world, WINDOWS.workflow, [
        "apps/windows/**", "apps/RelayiumKit/**", `.github/workflows/${WINDOWS.workflow}`,
      ]);
    },
    expect: /windows\.yml triggers on apps\/RelayiumKit/,
  },
  {
    name: "windows.yml's build job loses its timeout",
    mutate: (world) => {
      world.roots.add(WINDOWS.root);
      addWorkflow(world, WINDOWS.workflow, syntheticPlatform({
        workflow: WINDOWS.workflow, root: WINDOWS.root, run: "dotnet build apps/windows",
      }));
      return withJob(world, WINDOWS.workflow, (job) => { delete job["timeout-minutes"]; });
    },
    expect: /windows\.yml\/build: timeout-minutes is undefined/,
  },
  {
    name: "windows.yml's build job becomes advisory",
    mutate: (world) => {
      world.roots.add(WINDOWS.root);
      addWorkflow(world, WINDOWS.workflow, syntheticPlatform({
        workflow: WINDOWS.workflow, root: WINDOWS.root, run: "dotnet build apps/windows",
      }));
      return withJob(world, WINDOWS.workflow, (job) => { job["continue-on-error"] = "true"; });
    },
    expect: /windows\.yml\/build: continue-on-error makes this platform's gate advisory/,
  },
  {
    name: "windows.yml's build job retries until it agrees",
    mutate: (world) => {
      world.roots.add(WINDOWS.root);
      addWorkflow(world, WINDOWS.workflow, syntheticPlatform({
        workflow: WINDOWS.workflow,
        root: WINDOWS.root,
        run: "dotnet build apps/windows || dotnet build apps/windows # retry once",
      }));
      return world;
    },
    expect: /windows\.yml\/build: a retry appeared/,
  },
  // The REAL Android owner, mutated the way the real Apple owners are above:
  // these judge the files on disk, not a synthetic placeholder.
  {
    name: "android.yml adopts apps/ios, welding two platforms back together",
    mutate: (world) => withPaths(world, ANDROID_OWNER.workflow, [
      "apps/android/**", "apps/ios/**", `.github/workflows/${ANDROID_OWNER.workflow}`,
    ]),
    expect: /platform root apps\/ios also starts android\.yml/,
  },
  {
    name: "android.yml claims the Apple-shared package as cross-platform",
    mutate: (world) => withPaths(world, ANDROID_OWNER.workflow, [
      "apps/android/**", "apps/RelayiumKit/**", `.github/workflows/${ANDROID_OWNER.workflow}`,
    ]),
    expect: /android\.yml triggers on apps\/RelayiumKit/,
  },
  {
    name: "the Android build moves out of its one heavy owner",
    mutate: (world) => {
      const doc = world.docs.get(ANDROID_OWNER.workflow);
      if (!doc) throw new Error(`${ANDROID_OWNER.workflow} is not parsed`);
      for (const job of Object.values(doc.jobs ?? {})) {
        for (const step of job.steps ?? []) {
          if (String(step?.run ?? "").includes(ANDROID_OWNER.marker)) {
            step.run = String(step.run).replaceAll(ANDROID_OWNER.marker, ":app:help");
            return world;
          }
        }
      }
      throw new Error(`${ANDROID_OWNER.workflow} has no step running ${ANDROID_OWNER.marker}`);
    },
    expect: /runs in \[\]; want exactly \[android\.yml\]/,
  },
  {
    name: "an unknown apps/ root appears with no declared owner",
    mutate: (world) => { world.roots.add("apps/linux"); return world; },
    expect: /unknown platform root "apps\/linux" exists under apps\//,
  },
  {
    // `push.paths` set directly rather than through `withPaths`, which also
    // writes a `pull_request:` key: this file no longer has that trigger, and
    // a mutation that quietly restored it would be breaking two rules while
    // claiming to break one.
    name: "compat.yml gains a push path filter",
    mutate: (world) => {
      world.docs.get(COMPAT).on.push.paths = ["web/**", `.github/workflows/${COMPAT}`];
      return world;
    },
    expect: /compat\.yml gained a push path filter/,
  },
  {
    name: "compat.yml moves onto a platform runner",
    mutate: (world) => withJob(world, COMPAT, (job) => { job["runs-on"] = "macos-15"; }),
    expect: /compat\.yml\/wire-vectors runs on "macos-15"/,
  },
  {
    name: "compat.yml's job becomes advisory",
    mutate: (world) => withJob(world, COMPAT, (job) => { job["continue-on-error"] = "true"; }),
    expect: /continue-on-error makes the compatibility gate advisory/,
  },
  {
    name: "compat.yml's gate step becomes advisory",
    mutate: (world) => withJob(world, COMPAT, (job) => {
      job.steps[job.steps.length - 1]["continue-on-error"] = "true";
    }),
    expect: /compat\.yml\/wire-vectors: a step sets continue-on-error/,
  },
  {
    name: "compat.yml's gate step can skip itself",
    mutate: (world) => withJob(world, COMPAT, (job) => {
      job.steps[job.steps.length - 1].if = "github.event_name == 'push'";
    }),
    expect: /compat\.yml\/wire-vectors: a step sets "if:"/,
  },
  {
    name: "compat.yml's job can skip itself",
    mutate: (world) => withJob(world, COMPAT, (job) => { job.if = "github.actor != 'dependabot'"; }),
    expect: /compat\.yml\/wire-vectors: a job-level "if:"/,
  },
  {
    name: "compat.yml loses its timeout",
    mutate: (world) => withJob(world, COMPAT, (job) => { delete job["timeout-minutes"]; }),
    expect: /compat\.yml\/wire-vectors: timeout-minutes is undefined/,
  },
  {
    name: "compat.yml retries the contract check until it agrees",
    mutate: (world) => withJob(world, COMPAT, (job) => {
      job.steps[job.steps.length - 1].run = "npm run test:vectors --retries 3";
    }),
    expect: /compat\.yml\/wire-vectors: a retry appeared/,
  },
  {
    name: "compat.yml swallows the contract check's exit status",
    mutate: (world) => withJob(world, COMPAT, (job) => {
      job.steps[job.steps.length - 1].run = "npm run test:vectors || true";
    }),
    expect: /compat\.yml\/wire-vectors: a command swallows its own exit status/,
  },
  {
    // EVERY run step, not just the gate's. When the job gained a real dependency
    // install this case silently stopped working: echoing only the last step
    // left `npm ci` behind as a real run line, so the job was no longer a
    // placeholder, the complaint never came, and the case passed by asserting
    // nothing. Neutralising all of them restores what it was written to prove.
    name: "compat.yml becomes a placeholder that only echoes",
    mutate: (world) => withJob(world, COMPAT, (job) => {
      for (const step of job.steps) if (step.run) step.run = 'echo "wire vectors: TODO"';
    }),
    expect: /compat\.yml\/wire-vectors: has no real run step/,
  },
  // ── the dependency closure the gate cannot run without ────────────────────
  //
  // `5619f062` put a generator that imports `libsodium-wrappers` behind this
  // gate while the job installed nothing. These are the shapes that would let
  // that return: no install, a late install, a non-deterministic one, one
  // missing a flag, or one aimed at the wrong tree.
  {
    name: "compat.yml drops the dependency install entirely",
    mutate: (world) => withInstallStep(world, (step, job, at) => { job.steps.splice(at, 1); }),
    expect: /runs `npm run test:vectors` with no dependency install before it/,
  },
  {
    name: "the dependency install moves after the gate command",
    mutate: (world) => withInstallStep(world, (step, job, at) => {
      job.steps.push(...job.steps.splice(at, 1));
    }),
    expect: /installs its dependencies AFTER the gate command \(install at step 4, `npm run test:vectors` at step 3\)/,
  },
  {
    name: "the deterministic install is weakened to `npm install`",
    mutate: (world) => withInstallStep(world, (step) => {
      step.run = "npm install --ignore-scripts --omit=dev";
    }),
    expect: /the dependency install is `npm install --ignore-scripts --omit=dev`, which is not `npm ci`/,
  },
  {
    name: "the install stops omitting devDependencies",
    mutate: (world) => withInstallStep(world, (step) => { step.run = "npm ci --ignore-scripts"; }),
    expect: /the dependency install dropped `--omit=dev`/,
  },
  {
    name: "the install starts running package lifecycle scripts again",
    mutate: (world) => withInstallStep(world, (step) => { step.run = "npm ci --omit=dev"; }),
    expect: /the dependency install dropped `--ignore-scripts`/,
  },
  {
    name: "the dependency install is aimed at the wrong tree",
    mutate: (world) => withInstallStep(world, (step) => { step["working-directory"] = "server"; }),
    expect: /the dependency install declares working-directory "server", want "web"/,
  },
  {
    name: "the gate command loses its working directory and runs at the repo root",
    mutate: (world) => withCommandJob(world, COMPAT, VECTOR_COMMAND, (job, step) => {
      delete step["working-directory"];
    }),
    expect: /the gate command declares working-directory undefined, want "web"/,
  },
  // These two break the SAME check in opposite directions, so each demands the
  // host list it actually produces rather than the shared tail of the message.
  // Matching `want exactly [compat.yml]` would have let either mutation be
  // satisfied by the other's complaint — and, worse, by the complaint from a
  // world where the check had stopped working altogether.
  {
    name: "the vector command reappears in native-web-pairing.yml as well",
    mutate: (world) => {
      world.texts.set(NWP, `${world.texts.get(NWP)}\n        run: ${VECTOR_COMMAND}\n`);
      return world;
    },
    expect: /`npm run test:vectors` runs in \[compat\.yml, native-web-pairing\.yml\]/,
  },
  {
    name: "the vector command disappears from every workflow",
    mutate: (world) => {
      world.texts.set(COMPAT, world.texts.get(COMPAT).replace(VECTOR_COMMAND, "npm run check"));
      return world;
    },
    expect: /`npm run test:vectors` runs in \[\]; want exactly \[compat\.yml\]/,
  },
  {
    name: "compat.yml is deleted outright",
    mutate: (world) => { world.texts.delete(COMPAT); world.docs.delete(COMPAT); return world; },
    expect: /compat\.yml is missing/,
  },
  {
    name: "a workflow starts running the WRITING form of the generator",
    mutate: (world) => {
      world.texts.set(COMPAT, world.texts.get(COMPAT).replace(VECTOR_COMMAND, "npm run gen:vectors"));
      return world;
    },
    expect: /run the WRITING form of the vector generator/,
  },
  {
    name: "the pairing filter re-adopts apps/mac, which the acceptance never reads",
    mutate: (world) => withPaths(world, NWP, [
      "apps/mac/**", "apps/RelayiumKit/**", "web/**", "server/**",
      "scripts/native-web-pairing-acceptance.sh", "scripts/lib/local-acceptance.sh",
      `.github/workflows/${NWP}`,
    ]),
    expect: /native-web-pairing\.yml triggers on apps\/mac .*which is not an input to it/,
  },
  // A marker inside a `run:` block's own shell comment must NOT create
  // ownership. This is the only case here that asserts an ABSENCE, and it is
  // the direction that costs a red board on correct code: ios.yml explaining a
  // macOS command would otherwise report macOS as having two heavy owners.
  {
    name: "a macOS build marker appears inside an ios.yml run-block comment",
    mutate: (world) => {
      const jobs = world.docs.get(IOS).jobs;
      const job = jobs[Object.keys(jobs)[0]];
      (job.steps ??= []).push({
        name: "Note the macOS counterpart",
        run: `# the macOS half of this is ${MACOS_PROJECT}, built in ${MACOS}\nxcodebuild -list\n`,
      });
      return world;
    },
    refute: /platform root apps\/mac: the macOS app build .* runs in \[ios\.yml, macos\.yml\]/,
  },
  // ── the self-host check (6h) ─────────────────────────────────────────────
  {
    name: "repo-hygiene.yml stops running this policy at all",
    mutate: (world) => withCommandJob(world, SELF_HOST, SELF_COMMAND, (job, step) => {
      step.run = 'echo "ci-event-policy: TODO"';
    }),
    expect: /0 job\(s\) in repo-hygiene\.yml run `node scripts\/test\/ci-event-policy-test\.mjs`/,
  },
  {
    name: "the job that runs this policy becomes advisory",
    mutate: (world) => withCommandJob(world, SELF_HOST, SELF_COMMAND, (job) => {
      job["continue-on-error"] = "true";
    }),
    expect: /repo-hygiene\.yml\/ci-event-policy: continue-on-error makes this policy advisory/,
  },
  {
    name: "the job that runs this policy is allowed to skip itself",
    mutate: (world) => withCommandJob(world, SELF_HOST, SELF_COMMAND, (job) => {
      job.if = "github.actor != 'dependabot[bot]'";
    }),
    expect: /repo-hygiene\.yml\/ci-event-policy: a job-level "if:"/,
  },
  {
    name: "the step that runs this policy is allowed to skip itself",
    mutate: (world) => withCommandJob(world, SELF_HOST, SELF_COMMAND, (job, step) => {
      step.if = "github.event_name == 'push'";
    }),
    expect: /repo-hygiene\.yml\/ci-event-policy: a step sets "if:"/,
  },
  {
    name: "this policy's command swallows its own exit status",
    mutate: (world) => withCommandJob(world, SELF_HOST, SELF_COMMAND, (job, step) => {
      step.run = `${step.run} || true`;
    }),
    expect: /repo-hygiene\.yml\/ci-event-policy: the `node scripts\/test\/ci-event-policy-test\.mjs` command swallows/,
  },
  {
    name: "the job that runs this policy loses its timeout",
    mutate: (world) => withCommandJob(world, SELF_HOST, SELF_COMMAND, (job) => {
      delete job["timeout-minutes"];
    }),
    expect: /repo-hygiene\.yml\/ci-event-policy: timeout-minutes is undefined, want a finite positive number/,
  },
  {
    name: "the job that runs this policy declares a zero timeout",
    mutate: (world) => withCommandJob(world, SELF_HOST, SELF_COMMAND, (job) => {
      job["timeout-minutes"] = "0";
    }),
    expect: /repo-hygiene\.yml\/ci-event-policy: timeout-minutes is "0", want a finite positive number/,
  },
  {
    name: "the job that runs this policy declares a non-numeric timeout",
    mutate: (world) => withCommandJob(world, SELF_HOST, SELF_COMMAND, (job) => {
      job["timeout-minutes"] = "soon";
    }),
    expect: /repo-hygiene\.yml\/ci-event-policy: timeout-minutes is "soon", want a finite positive number/,
  },
  {
    name: "the job that runs this policy declares a timeout above the ceiling",
    mutate: (world) => withCommandJob(world, SELF_HOST, SELF_COMMAND, (job) => {
      job["timeout-minutes"] = "360";
    }),
    expect: /repo-hygiene\.yml\/ci-event-policy: timeout-minutes is "360", above the 10-minute ceiling/,
  },
  {
    name: "repo-hygiene.yml gains a push path filter, hiding this policy behind it",
    mutate: (world) => withPaths(world, SELF_HOST, [
      "web/**", `.github/workflows/${SELF_HOST}`,
    ]),
    expect: /repo-hygiene\.yml gained a push path filter/,
  },
  // 6i, one property at a time. Each of these was the real state of the tree
  // until the architecture-resilience P0 pass, so none of them is hypothetical.
  {
    name: "ios.yml loses its runner timeout and inherits GitHub's 6-hour default",
    mutate: (world) => withJob(world, IOS, (job) => { delete job["timeout-minutes"]; }),
    expect: /ios\.yml\/ios-build: timeout-minutes is undefined, want a finite positive number/,
  },
  {
    name: "release.yml loses its runner timeout",
    mutate: (world) => withJob(world, RELEASE, (job) => { delete job["timeout-minutes"]; }),
    expect: /release\.yml\/goreleaser: timeout-minutes is undefined, want a finite positive number/,
  },
  {
    name: "release.yml declares a bound that is the 6-hour default wearing a number",
    mutate: (world) => withJob(world, RELEASE, (job) => { job["timeout-minutes"] = "360"; }),
    expect: /release\.yml\/goreleaser: timeout-minutes is "360", above the 60-minute ceiling/,
  },
  {
    name: "ios.yml declares a non-numeric timeout, which GitHub would ignore",
    mutate: (world) => withJob(world, IOS, (job) => { job["timeout-minutes"] = "soon"; }),
    expect: /ios\.yml\/ios-build: timeout-minutes is "soon", want a finite positive number/,
  },
  {
    name: "the iOS UI smoke is serialized behind the build job",
    mutate: (world) => withNamedJob(world, IOS, "ios-ui-smoke", (job) => {
      job.needs = "ios-build";
    }),
    expect: /ios\.yml\/ios-ui-smoke declares `needs: "ios-build"`/,
  },
  {
    name: "the parallel iOS transfer job drops cleanup acceptance",
    mutate: (world) => withNamedJob(world, IOS_TRANSFER_INTEROP, "ios-transfer-acceptance", (job) => {
      const step = job.steps.find((candidate) => String(candidate.run ?? "")
        .includes("local-transfer-cleanup-test.sh"));
      step.run = step.run.replace("scripts/local-transfer-cleanup-test.sh", "true");
    }),
    expect: /ios-transfer-interop\.yml\/ios-transfer-acceptance does not contain "local-transfer-cleanup-test\.sh"/,
  },
  // The macOS lane, budgeted per job. Each case below names ONE job, and each
  // uses `withNamedJob` so a reorder of `macos.yml`'s six jobs is a thrown
  // error rather than a case that quietly moves to a different job.
  {
    // The job that imports the Developer ID certificate. Unbounded, a wedged
    // build holds a paid runner for six hours with the signing key on disk.
    name: "macos.yml's signing build loses its timeout and inherits the 6-hour default",
    mutate: (world) => withNamedJob(world, MACOS, "signed-build", (job) => {
      delete job["timeout-minutes"];
    }),
    expect: /macos\.yml\/signed-build: timeout-minutes is undefined, want a finite positive number/,
  },
  {
    // The per-job point. `contract` reads a project file in seconds; 60 minutes
    // would be inside `signed-build`'s bound and is nowhere near this job's.
    // A single file-wide ceiling could not tell these two apart.
    name: "macos.yml's contract check is raised to a bound that only its slowest sibling deserves",
    mutate: (world) => withNamedJob(world, MACOS, "contract", (job) => {
      job["timeout-minutes"] = "60";
    }),
    expect: /macos\.yml\/contract: timeout-minutes is "60", above the 15-minute ceiling/,
  },
  {
    // The matrix bound is a real bound and is checked as one.
    name: "macos.yml's device-inbox UI shard is raised past the ui-smoke ceiling",
    mutate: (world) => withNamedJob(world, MACOS, "ui-smoke", (job) => {
      job.strategy.matrix.include[1].timeout = "300";
    }),
    expect: /macos\.yml\/ui-smoke: include\[1\]'s `timeout` \(read by `timeout-minutes`\) is "300", above the 45-minute ceiling/,
  },
  {
    // An include entry that stops carrying the key the expression reads. GitHub
    // substitutes nothing, so the job runs with no timeout at all.
    name: "macos.yml's app-shell UI shard drops the matrix key its timeout reads",
    mutate: (world) => withNamedJob(world, MACOS, "ui-smoke", (job) => {
      delete job.strategy.matrix.include[0].timeout;
    }),
    expect: /macos\.yml\/ui-smoke: include\[0\]'s `timeout` \(read by `timeout-minutes`\) is undefined, want a finite positive number/,
  },
  {
    // The expression survives but the matrix it reads does not. Iterating an
    // empty include list would have passed by inspecting nothing.
    name: "macos.yml's ui-smoke keeps a matrix timeout expression with no matrix behind it",
    mutate: (world) => withNamedJob(world, MACOS, "ui-smoke", (job) => { delete job.strategy; }),
    expect: /macos\.yml\/ui-smoke: timeout-minutes reads `matrix\.timeout`, but this job declares no `strategy\.matrix\.include` entries/,
  },
  {
    // Tightening this one is the expensive direction: below Apple's own wait,
    // a slow-but-succeeding notarization is killed mid-wait and the submission
    // is burned.
    name: "macos-release.yml's notarize-stage is tightened below the wait its own script allows",
    mutate: (world) => withNamedJob(world, MACOS_RELEASE, "notarize-stage", (job) => {
      job["timeout-minutes"] = "30";
    }),
    expect: /macos-release\.yml\/notarize-stage: timeout-minutes is "30", at or below the 45-minute floor/,
  },
  {
    // A new paid-runner job arriving with no budget decided for it.
    name: "macos.yml gains a job this policy has no budget for",
    mutate: (world) => {
      world.docs.get(MACOS).jobs["ui-acceptance"] = {
        "runs-on": "macos-15",
        "timeout-minutes": "120",
        steps: [{ name: "Acceptance", run: "true\n" }],
      };
      return world;
    },
    expect: /macos\.yml\/ui-acceptance: this policy declares per-job runner budgets for macos\.yml and none for `ui-acceptance`/,
  },
  {
    // And the other direction: a rename moves a budgeted job into the
    // unbudgeted case while the budget list still looks complete.
    name: "macos-release.yml renames a budgeted job, so its budget names nothing",
    mutate: (world) => {
      const jobs = world.docs.get(MACOS_RELEASE).jobs;
      jobs.notarize = jobs["notarize-stage"];
      delete jobs["notarize-stage"];
      return world;
    },
    expect: /macos-release\.yml declares no job named `notarize-stage`, but this policy carries a runner budget for it/,
  },
  // The contract lane. A workflow that landed after every rule above was
  // written is the case this section is least likely to cover by accident, so
  // both halves of its registration — the governed list and the runner budget —
  // are deleted and corrupted here, one at a time.
  {
    // The registration itself, removed. The workflow keeps running and keeps
    // reporting green; what stops, silently, is every trigger, concurrency and
    // path rule in this file binding it. A per-lane policy elsewhere cannot
    // notice this, because it never reads this list.
    name: "contracts.yml is dropped from the governed inventory",
    mutate: (world) => {
      world.governed = world.governed.filter((entry) => entry.file !== CONTRACTS);
      return world;
    },
    expect: /changing "contracts\/device-inbox-admission-v1\.json" starts \[\]; want \[contracts\.yml\]/,
  },
  {
    // And the lane leaving the world entirely — renamed, deleted or unparseable
    // — while the budget still names it. The budget then bounds nothing.
    name: "contracts.yml is renamed out from under its runner budget",
    mutate: (world) => { world.docs.delete(CONTRACTS); return world; },
    expect: /contracts\.yml is missing or did not parse, so its runner budget/,
  },
  // The deploy contract lane. Newest workflow in the inventory, so — by the same
  // argument as the block above — both halves of its registration are deleted
  // and corrupted here, one at a time.
  {
    // The registration removed. The lane keeps running and keeps reporting
    // green; what stops, silently, is every trigger, concurrency and path rule
    // in this file binding it.
    name: "ops-deploy-contract.yml is dropped from the governed inventory",
    mutate: (world) => {
      world.governed = world.governed.filter((entry) => entry.file !== OPS_DEPLOY_CONTRACT);
      return world;
    },
    expect: /changing "contracts\/ops-deploy-v1\.json" starts \[\]; want \[ops-deploy-contract\.yml\]/,
  },
  {
    // And the lane leaving the world entirely — renamed, deleted or unparseable
    // — while the budget still names it. The budget then bounds nothing.
    name: "ops-deploy-contract.yml is renamed out from under its runner budget",
    mutate: (world) => { world.docs.delete(OPS_DEPLOY_CONTRACT); return world; },
    expect: /ops-deploy-contract\.yml is missing or did not parse, so its runner budget/,
  },
  {
    name: "the deploy contract lane's only job loses its bound",
    mutate: (world) => withNamedJob(world, OPS_DEPLOY_CONTRACT, "go-contract", (job) => {
      delete job["timeout-minutes"];
    }),
    expect: /ops-deploy-contract\.yml\/go-contract: timeout-minutes is undefined, want a finite positive number/,
  },
  {
    // The other direction: the bound kept, raised until it is the six-hour
    // default wearing a number.
    name: "the deploy contract lane's bound is raised past its ceiling",
    mutate: (world) => withNamedJob(world, OPS_DEPLOY_CONTRACT, "go-contract", (job) => {
      job["timeout-minutes"] = "300";
    }),
    expect: /ops-deploy-contract\.yml\/go-contract: timeout-minutes is "300", above the 15-minute ceiling/,
  },
  {
    // The whole reason this lane is separate: a deploy-contract edit reaching
    // the three-consumer lane and taking a PAID macOS runner with it.
    name: "the deploy contract is routed back into the three-consumer lane",
    mutate: (world) => withPaths(world, CONTRACTS, [
      "contracts/device-inbox-admission-v1.json",
      "contracts/ops-deploy-v1.json",
      `.github/workflows/${CONTRACTS}`,
    ]),
    expect: /changing "contracts\/ops-deploy-v1\.json" starts \[contracts\.yml, ops-deploy-contract\.yml\]/,
  },
  {
    name: "the contract lane's PAID macOS job loses its bound",
    mutate: (world) => withNamedJob(world, CONTRACTS, "swift-contract", (job) => {
      delete job["timeout-minutes"];
    }),
    expect: /contracts\.yml\/swift-contract: timeout-minutes is undefined, want a finite positive number/,
  },
  {
    // The other direction: the bound kept, raised until it is the six-hour
    // default wearing a number.
    name: "the contract lane's PAID macOS job is raised past its cold-build ceiling",
    mutate: (world) => withNamedJob(world, CONTRACTS, "swift-contract", (job) => {
      job["timeout-minutes"] = "300";
    }),
    expect: /contracts\.yml\/swift-contract: timeout-minutes is "300", above the 30-minute ceiling/,
  },
  {
    // The per-job point, inside this file: 25 minutes is `swift-contract`'s
    // legitimate cold-build bound and nowhere near a Go test selector's. A
    // file-wide ceiling could not tell the two apart.
    name: "the contract lane's Go job is raised to its macOS sibling's bound",
    mutate: (world) => withNamedJob(world, CONTRACTS, "go-contract", (job) => {
      job["timeout-minutes"] = "25";
    }),
    expect: /contracts\.yml\/go-contract: timeout-minutes is "25", above the 15-minute ceiling/,
  },
  {
    name: "the contract lane's Web job loses its bound",
    mutate: (world) => withNamedJob(world, CONTRACTS, "web-contract", (job) => {
      delete job["timeout-minutes"];
    }),
    expect: /contracts\.yml\/web-contract: timeout-minutes is undefined, want a finite positive number/,
  },
  {
    // A fourth consumer arriving with no budget decided for it — the shape a
    // new platform's contract job takes on the day it lands.
    name: "the contract lane gains a consumer job this policy has no budget for",
    mutate: (world) => {
      world.docs.get(CONTRACTS).jobs["android-contract"] = {
        "runs-on": "ubuntu-latest",
        "timeout-minutes": "10",
        steps: [{ name: "The Android half", run: "./gradlew contractTest\n" }],
      };
      return world;
    },
    expect: /contracts\.yml\/android-contract: this policy declares per-job runner budgets for contracts\.yml and none for `android-contract`/,
  },
  {
    // And the rename that moves a budgeted job into the unbudgeted case while
    // the list still looks complete.
    name: "a budgeted contract job is renamed, so its budget names nothing",
    mutate: (world) => {
      const jobs = world.docs.get(CONTRACTS).jobs;
      jobs["swift-contracts"] = jobs["swift-contract"];
      delete jobs["swift-contract"];
      return world;
    },
    expect: /contracts\.yml declares no job named `swift-contract`, but this policy carries a runner budget for it/,
  },
  {
    name: "the [macos-only] escape returns to ios.yml under a different marker",
    mutate: (world) => withJob(world, IOS, (job) => {
      job.if = "!contains(github.event.head_commit.message, '[skip-ios]')";
    }),
    expect: /ios\.yml\/ios-build: a condition reads the commit message/,
  },
  {
    name: "a release step learns to skip itself on a commit-message marker",
    mutate: (world) => withJob(world, RELEASE, (job) => {
      job.steps[0].if = "!contains(github.event.head_commit.message, '[no-release]')";
    }),
    expect: /release\.yml\/goreleaser: a condition reads the commit message/,
  },
  {
    name: "ios.yml regains a job-level condition of any shape",
    mutate: (world) => withJob(world, IOS, (job) => { job.if = "github.actor != 'nobody'"; }),
    expect: /ios\.yml\/ios-build: a job-level "if:" is back/,
  },
  {
    name: "the literal [macos-only] marker returns to ios.yml as live YAML",
    mutate: (world) => {
      world.texts.set(IOS, `${world.texts.get(IOS)}\n    if: "${SKIP_MARKER}"\n`);
      return world;
    },
    expect: /ios\.yml contains the `\[macos-only\]` commit-message marker again/,
  },
  {
    // The opposite obligation: a step that runs only when the job already
    // failed cannot skip a build, and `ios.yml` carries exactly one. A budget
    // check that fired on it would be widened until it fired on nothing.
    name: "a failure-only diagnosis step keeps its `if:`",
    mutate: (world) => withNamedJob(world, IOS_TRANSFER_INTEROP, "ios-transfer-acceptance", (job) => {
      job.steps[job.steps.length - 1].if = "failure()";
    }),
    refute: /ios-transfer-interop\.yml\/ios-transfer-acceptance: a condition reads the commit message/,
  },
  {
    // 6i again, in the direction the check itself can fail SILENTLY. The marker
    // assertion reads `world.texts`, and a budget lane whose text never arrives
    // would have it inspect the empty string and report a pass — the same
    // non-assertion this whole section exists to prevent. So the guard that
    // catches that has its own mutation, exactly like every rule it protects.
    name: "release.yml's comment-stripped source never reaches this world",
    mutate: (world) => { world.texts.delete(RELEASE); return world; },
    expect: /release\.yml is parsed for its runner budget but its comment-stripped source never reached this world/,
  },
  // ── the required status context's job name (6j) ──────────────────────────
  // A collision here is the one substitution `app_id` 15368 cannot refuse,
  // because the impostor is the same app. Both cases below leave every workflow
  // valid, actionlint quiet and the board green.
  {
    name: "web.yml declares a second job named wire-vectors — same repo, same app, same context",
    mutate: (world) => {
      world.docs.get(WEB).jobs[COMPAT_JOB] = {
        "runs-on": "ubuntu-latest",
        "timeout-minutes": "5",
        steps: [{ name: "Check", run: "npm run check\n" }],
      };
      return world;
    },
    expect: /\[web\.yml\] also declare a job named `wire-vectors`/,
  },
  {
    // And in a workflow this policy deliberately does not parse, which is where
    // the collision is least likely to be noticed by a reader. Scanning only
    // GOVERNED would report green on this tree.
    name: "auto-release.yml, which is not parsed here, declares a wire-vectors job",
    mutate: (world) => {
      const text = world.texts.get(AUTO_RELEASE);
      world.texts.set(AUTO_RELEASE, text.replace(
        /^jobs:\s*$/m,
        `jobs:\n  ${COMPAT_JOB}:\n    runs-on: ubuntu-latest\n    steps:\n      - run: exit 0\n`,
      ));
      return world;
    },
    expect: /\[auto-release\.yml\] also declare a job named `wire-vectors`/,
  },
  {
    // The trigger-matrix half, and the row this file learned the hard way: the
    // document is not source, so nothing about web.yml LOOKS wrong without it.
    // Removing the one entry is exactly the edit a reader tidying a "docs file
    // in a web workflow" would make, and it is silent — `npm test` still runs
    // billing-doc-pointers.test.mjs, just never on a commit that only touched
    // the document it reads.
    name: "web.yml stops watching the billing document its own test suite reads",
    mutate: (world) => withoutPath(world, WEB, "docs/billing-transparency.md"),
    expect: /changing "docs\/billing-transparency\.md" starts \[\]; want \[web\.yml\]/,
  },
  {
    // The non-vacuity half. In this world the uniqueness check above is
    // trivially satisfied — nothing collides with a name nothing declares —
    // while one of `main`'s two required contexts is reported by no run at all.
    name: "compat.yml's job is renamed, so the required context is reported by nothing",
    mutate: (world) => {
      const jobs = world.docs.get(COMPAT).jobs;
      jobs.vectors = jobs[COMPAT_JOB];
      delete jobs[COMPAT_JOB];
      return world;
    },
    expect: /compat\.yml declares no job named `wire-vectors`; it declares \[android-protocol, cli-interop-guards, vectors\]/,
  },
  // ── the fuzz campaign (7) ────────────────────────────────────────────────
  //
  // Each of these leaves every workflow valid, actionlint quiet and the board
  // green. Several of them leave the campaign RUNNING, too — just running less,
  // or running the wrong thing, which is the shape that never gets noticed.
  {
    name: "the campaign becomes a gate again",
    mutate: (world) => {
      world.docs.get(FUZZ_NIGHTLY).on.pull_request = null;
      return world;
    },
    expect: /go-fuzz-nightly\.yml gained a `push` or `pull_request` trigger/,
  },
  {
    name: "the campaign loses its schedule and only ever runs when asked",
    mutate: (world) => {
      delete world.docs.get(FUZZ_NIGHTLY).on.schedule;
      return world;
    },
    expect: /go-fuzz-nightly\.yml's triggers are \[workflow_dispatch\]/,
  },
  {
    name: "the campaign gains a write token",
    mutate: (world) => {
      world.docs.get(FUZZ_NIGHTLY).permissions = { contents: "write" };
      return world;
    },
    expect: /permissions are \{"contents":"write"\}/,
  },
  {
    name: "the campaign reads a secret",
    mutate: (world) => withCommandJob(world, FUZZ_NIGHTLY, "go test -run", (job, step) => {
      step.env = { TOKEN: "${{ secrets.SOME_TOKEN }}" };
    }),
    expect: /reads a `secrets\.` value/,
  },
  {
    name: "the discovered matrix is replaced by a hand-written list",
    mutate: (world) => withCommandJob(world, FUZZ_NIGHTLY, "go test -run", (job) => {
      job.strategy.matrix = {
        include: [{ package: "github.com/relayium/relayium/internal/dltoken", target: "FuzzSignVerify", id: "x" }],
      };
    }),
    expect: /want a `fromJSON\(needs\.…\)` expression/,
  },
  {
    name: "the matrix is fed by something other than the discovery job",
    mutate: (world) => withCommandJob(world, FUZZ_NIGHTLY, "go test -run", (job) => {
      job.strategy.matrix = "${{ fromJSON(needs.build.outputs.matrix) }}";
    }),
    expect: /its matrix does not read an output of `discover`/,
  },
  {
    name: "the campaign stops depending on the job that discovers its targets",
    mutate: (world) => withCommandJob(world, FUZZ_NIGHTLY, "go test -run", (job) => {
      delete job.needs;
    }),
    expect: /does not declare `needs: discover`/,
  },
  {
    name: "one target's crash cancels every other target",
    mutate: (world) => withCommandJob(world, FUZZ_NIGHTLY, "go test -run", (job) => {
      delete job.strategy["fail-fast"];
    }),
    expect: /strategy\.fail-fast is undefined, want false/,
  },
  {
    name: "the discovery step stops asking for the machine-readable form",
    mutate: (world) => withCommandJob(world, FUZZ_NIGHTLY, FUZZ_INVENTORY, (job, step) => {
      step.run = String(step.run).replace(/ --json/g, "");
    }),
    expect: /never asks `scripts\/list-go-fuzz-targets\.sh` for its `--json` form/,
  },
  {
    name: "discovery is replaced by a list the workflow carries itself",
    mutate: (world) => withCommandJob(world, FUZZ_NIGHTLY, FUZZ_INVENTORY, (job, step) => {
      step.run = 'echo "matrix={\\"include\\":[]}" >> "$GITHUB_OUTPUT"\n';
    }),
    expect: /want exactly one\. Zero is a hand-maintained target list/,
  },
  {
    name: "the discovery job keeps its step output to itself",
    mutate: (world) => withCommandJob(world, FUZZ_NIGHTLY, FUZZ_INVENTORY, (job) => {
      delete job.outputs;
    }),
    expect: /declares no `outputs:`/,
  },
  {
    // The shape this workflow actually shipped with, and the reason the check
    // exists: a human-readable call added above the `--json` one for the log.
    // Everything still works. It just enumerates the module twice, and the two
    // answers are never compared.
    name: "the discovery step lists the module a second time for the log",
    mutate: (world) => withCommandJob(world, FUZZ_NIGHTLY, FUZZ_INVENTORY, (job, step) => {
      step.run = `scripts/list-go-fuzz-targets.sh\n${String(step.run)}`;
    }),
    expect: /invokes `scripts\/list-go-fuzz-targets\.sh` 2 times; want exactly one/,
  },
  {
    // A comment that names the script must NOT count as running it, or the
    // check above would fire on the real workflow, which explains itself at
    // length. This case asserts the count is taken over commands.
    name: "a comment mentioning the inventory script is not an invocation",
    mutate: (world) => withCommandJob(world, FUZZ_NIGHTLY, FUZZ_INVENTORY, (job, step) => {
      step.run = `# scripts/list-go-fuzz-targets.sh is what this runs\n${String(step.run)}`;
    }),
    refute: /invokes `scripts\/list-go-fuzz-targets\.sh` \d+ times/,
  },
  {
    name: "two campaign jobs can collide on one crasher artifact name",
    mutate: (world) => withCommandJob(world, FUZZ_NIGHTLY, "go test -run", (job) => {
      const upload = (job.steps ?? []).find(
        (step) => String(step?.uses ?? "").startsWith("actions/upload-artifact@"),
      );
      upload.with.name = "fuzz-crashers-${{ matrix.target }}";
    }),
    expect: /which is not derived from `matrix\.id`/,
  },
  {
    name: "the inventory script is deleted from the repository",
    mutate: (world) => { world.inventory = false; return world; },
    expect: /scripts\/list-go-fuzz-targets\.sh is missing, and it is what tells the campaign/,
  },
  {
    name: "the campaign job loses its timeout",
    mutate: (world) => withCommandJob(world, FUZZ_NIGHTLY, "go test -run", (job) => {
      delete job["timeout-minutes"];
    }),
    expect: /go-fuzz-nightly\.yml\/fuzz: timeout-minutes is undefined/,
  },
  {
    name: "the campaign fuzzes until something else stops it",
    mutate: (world) => withCommandJob(world, FUZZ_NIGHTLY, "go test -run", (job, step) => {
      step.run = String(step.run).replace(/-fuzztime \S+ /, "");
    }),
    expect: /no finite `-fuzztime`/,
  },
  {
    name: "the fuzz budget grows past the harness timeout that bounds it",
    mutate: (world) => withCommandJob(world, FUZZ_NIGHTLY, "go test -run", (job, step) => {
      step.run = String(step.run).replace(/-fuzztime \S+/, "-fuzztime 30m");
    }),
    expect: /is not below the go test `-timeout`/,
  },
  {
    name: "the harness timeout grows past the job budget that bounds it",
    mutate: (world) => withCommandJob(world, FUZZ_NIGHTLY, "go test -run", (job, step) => {
      step.run = String(step.run).replace(/-timeout \S+/, "-timeout 90m");
    }),
    expect: /is not below the job's timeout-minutes/,
  },
  {
    name: "the `-fuzz` pattern loses its anchors and adopts its neighbours",
    mutate: (world) => withCommandJob(world, FUZZ_NIGHTLY, "go test -run", (job, step) => {
      step.run = String(step.run).replace(/-fuzz '[^']*'/, "-fuzz ${{ matrix.target }}");
    }),
    expect: /the `-fuzz` pattern is not the anchored/,
  },
  {
    name: "the campaign swallows the crash it just found",
    mutate: (world) => withCommandJob(world, FUZZ_NIGHTLY, "go test -run", (job, step) => {
      step.run = `${String(step.run).trimEnd()} || true\n`;
    }),
    expect: /go-fuzz-nightly\.yml\/fuzz: a command swallows its own exit status/,
  },
  {
    name: "the crasher upload runs on every night, crash or not",
    mutate: (world) => withCommandJob(world, FUZZ_NIGHTLY, "go test -run", (job) => {
      const upload = job.steps.find((step) => String(step?.uses ?? "").includes("upload-artifact"));
      delete upload.if;
    }),
    expect: /the crasher upload's `if:` is undefined, want "failure\(\)"/,
  },
  {
    name: "the crasher upload moves to a floating tag",
    mutate: (world) => withCommandJob(world, FUZZ_NIGHTLY, "go test -run", (job) => {
      const upload = job.steps.find((step) => String(step?.uses ?? "").includes("upload-artifact"));
      upload.uses = "actions/upload-artifact@v7";
    }),
    expect: /not pinned to a full 40-character commit SHA/,
  },
  {
    name: "the crasher artifact is kept for however long the default says",
    mutate: (world) => withCommandJob(world, FUZZ_NIGHTLY, "go test -run", (job) => {
      const upload = job.steps.find((step) => String(step?.uses ?? "").includes("upload-artifact"));
      delete upload.with["retention-days"];
    }),
    expect: /retention-days is undefined/,
  },
  {
    name: "the crasher upload is aimed at a directory go test never writes",
    mutate: (world) => withCommandJob(world, FUZZ_NIGHTLY, "go test -run", (job) => {
      const upload = job.steps.find((step) => String(step?.uses ?? "").includes("upload-artifact"));
      upload.with.path = "server/coverage";
    }),
    expect: /which does not name testdata\/fuzz/,
  },
  {
    name: "the whole campaign workflow is deleted",
    mutate: (world) => {
      world.docs.delete(FUZZ_NIGHTLY);
      world.texts.delete(FUZZ_NIGHTLY);
      return world;
    },
    expect: /go-fuzz-nightly\.yml is missing or unparseable/,
  },
  {
    // The other direction, and the expensive one: fuzzing that migrates back
    // into a lane every change waits for.
    name: "go.yml starts generating fuzz inputs on every pull request",
    mutate: (world) => withCommandJob(world, "go.yml", `go test -skip '${RENEW_PATTERN}' ./...`, (job, step) => {
      step.run = "go test -fuzz '^Fuzz' -fuzztime 10m ./...\n";
    }),
    expect: /go\.yml\/test runs a timed fuzz campaign/,
  },
  {
    name: "go.yml stops watching the script that decides what gets fuzzed",
    mutate: (world) => withoutPath(world, "go.yml", FUZZ_INVENTORY),
    expect: /changing "scripts\/list-go-fuzz-targets\.sh" starts \[\]; want \[go\.yml\]/,
  },
  {
    name: "go.yml stops watching the campaign workflow itself",
    mutate: (world) => withoutPath(world, "go.yml", `.github/workflows/${FUZZ_NIGHTLY}`),
    expect: /changing "\.github\/workflows\/go-fuzz-nightly\.yml" starts \[\]; want \[go\.yml\]/,
  },
  {
    // The false positive that would get 7a widened until it caught nothing:
    // running the DISCOVERY script on a pull request is a legitimate thing to
    // want, and its name contains the letters the fuzz check looks for.
    name: "go.yml runs the inventory script as an ordinary check",
    mutate: (world) => withCommandJob(world, "go.yml", `go test -skip '${RENEW_PATTERN}' ./...`, (job, step) => {
      step.run = `${String(step.run).trimEnd()}\n${FUZZ_INVENTORY}\n`;
    }),
    refute: /go\.yml\/test runs a timed fuzz campaign/,
  },

  {
    // 6l's own shape: a governed macOS lane that `RUNNER_BUDGETS` covers
    // nowhere. This is what `native-web-pairing.yml` was before it had an
    // entry, and what a new macOS workflow looks like on the day it lands.
    name: "a governed workflow gains a macOS job that RUNNER_BUDGETS covers nowhere",
    mutate: (world) => {
      world.docs.get(WEB).jobs["mac-smoke"] = {
        "runs-on": "macos-15",
        "timeout-minutes": "30",
        steps: [{ name: "smoke", run: "npm run smoke\n" }],
      };
      return world;
    },
    expect: /web\.yml\/mac-smoke runs on "macos-15" — a PAID runner — and section 6i declares no runner-budget ceiling/,
  },
  {
    // The same job with no bound at all: a PAID macOS runner on GitHub's
    // six-hour default.
    name: "a governed macOS job appears with no finite bound",
    mutate: (world) => {
      world.docs.get(WEB).jobs["mac-smoke"] = {
        "runs-on": "macos-15",
        steps: [{ name: "smoke", run: "npm run smoke\n" }],
      };
      return world;
    },
    expect: /web\.yml\/mac-smoke: timeout-minutes is undefined/,
  },
  // ── the macOS CI/release boundary (sections 2 and 6m) ────────────────────
  //
  // Every case below is a shape the split removed, written the way it would
  // actually come back: one line edited in a file that stays valid.
  {
    // The deadlock. `macos.yml` is a reusable callee, and inside one
    // `github.workflow` is the CALLER's name.
    name: "the reusable callee's concurrency group goes back to ${{ github.workflow }}",
    mutate: (world) => {
      world.docs.get(MACOS).concurrency.group = GROUP;
      return world;
    },
    expect: /macos\.yml: it is a reusable workflow \(`on: workflow_call`\) and its concurrency\.group/,
  },
  {
    // The same collision reached from the other side: two literals that agree.
    name: "the release caller and the CI callee resolve to the same group prefix",
    mutate: (world) => {
      world.docs.get(MACOS_RELEASE).concurrency.group = `macos-ci-${GROUP_SUFFIX}`;
      return world;
    },
    expect: /both resolve their concurrency group to the prefix "macos-ci"/,
  },
  {
    name: "the CI callee gains a manual dispatch again",
    mutate: (world) => {
      world.docs.get(MACOS).on.workflow_dispatch = null;
      return world;
    },
    expect: /macos\.yml has a `workflow_dispatch:` again/,
  },
  {
    name: "the CI callee declares an input no job reads",
    mutate: (world) => {
      world.docs.get(MACOS).on.workflow_call.inputs.validate_sparkle_key = {
        required: "false", default: "false", type: "boolean",
      };
      return world;
    },
    expect: /macos\.yml's `workflow_call` declares inputs \[.*validate_sparkle_key/,
  },
  {
    // The default IS the CI behaviour: an ordinary push passes no inputs.
    name: "a call input defaults to a release rather than to CI",
    mutate: (world) => {
      world.docs.get(MACOS).on.workflow_call.inputs.notarize.default = "true";
      return world;
    },
    expect: /input `notarize` defaults to "true", want "false"/,
  },
  {
    name: "the CI callee declares the notary key among its secrets",
    mutate: (world) => {
      world.docs.get(MACOS).on.workflow_call.secrets.MACOS_NOTARY_KEY_P8_BASE64 = {
        required: "false",
      };
      return world;
    },
    expect: /macos\.yml's `workflow_call` declares secrets \[.*MACOS_NOTARY_KEY_P8_BASE64/,
  },
  {
    // Valid YAML, valid expression syntax, silently empty at run time.
    name: "the signed-artifact output is written in dotted rather than bracket form",
    mutate: (world) => {
      world.docs.get(MACOS).on.workflow_call.outputs.signed_artifact.value =
        "${{ jobs.signed-build.outputs.signed_artifact }}";
      return world;
    },
    expect: /does not read `jobs\['signed-build'\]` in BRACKET form/,
  },
  {
    // Two copies of one naming expression, in two files.
    name: "the signed upload re-derives the artifact name instead of reading the step output",
    mutate: (world) => withNamedJob(world, MACOS, "signed-build", (job) => {
      const upload = job.steps.find((step) => String(step.uses ?? "").startsWith("actions/upload-artifact"));
      upload.with.name = "relayium-macos-signed-${{ github.sha }}-${{ inputs.release_version || 'ci' }}";
    }),
    expect: /the upload names the artifact .*which is not the same/,
  },
  {
    name: "the step that computes the artifact name stops writing it to GITHUB_OUTPUT",
    mutate: (world) => withNamedJob(world, MACOS, "signed-build", (job) => {
      const step = job.steps.find((s) => s.id === "package_identity");
      step.run = step.run.replace(/artifact_name=/g, "unused_name=");
    }),
    expect: /no `package_identity` step writes `artifact_name=` to/,
  },
  {
    name: "a publish job is restored into the workflow that runs on every pull request",
    mutate: (world) => {
      world.docs.get(MACOS).jobs.publish = {
        "runs-on": "ubuntu-latest",
        "timeout-minutes": "15",
        permissions: { contents: "write" },
        steps: [{ name: "publish", run: "gh release create macos-v1.0\n" }],
      };
      return world;
    },
    expect: /macos\.yml declares jobs \[.*publish\]; want exactly/,
  },
  {
    name: "a CI job widens the read-only default for itself",
    mutate: (world) => withNamedJob(world, MACOS, "signed-build", (job) => {
      job.permissions = { contents: "write" };
    }),
    expect: /macos\.yml\/signed-build declares its own `permissions:`/,
  },
  {
    // The text half of the same boundary: an operation, not a job name.
    name: "an irreversible command appears in the CI half's source",
    mutate: (world) => {
      world.texts.set(MACOS, `${world.texts.get(MACOS)}\n      run: gh release create macos-v1.0\n`);
      return world;
    },
    expect: /macos\.yml contains `gh release create`/,
  },
  {
    name: "the release workflow gains an automatic trigger",
    mutate: (world) => {
      world.docs.get(MACOS_RELEASE).on.push = { branches: ["main"] };
      return world;
    },
    expect: /macos-release\.yml triggers on \[workflow_dispatch, push\]; want exactly \[workflow_dispatch\]/,
  },
  {
    // The operator's controls moved; a label that drifted in the move describes
    // something else now.
    name: "a dispatch input's description drifts from the one that moved",
    mutate: (world) => {
      world.docs.get(MACOS_RELEASE).on.workflow_dispatch.inputs.publish_release.description =
        "Publish the release";
      return world;
    },
    expect: /dispatch input `publish_release` declares description/,
  },
  {
    name: "the reusable call forwards every secret this repository holds",
    mutate: (world) => withNamedJob(world, MACOS_RELEASE, "build", (job) => {
      job.secrets = "inherit";
    }),
    expect: /macos-release\.yml\/build declares `secrets: "inherit"`/,
  },
  {
    name: "the reusable release build caller grants a write",
    mutate: (world) => withNamedJob(world, MACOS_RELEASE, "build", (job) => {
      job.permissions = { ...job.permissions, contents: "write" };
    }),
    expect: /macos-release\.yml\/build declares `permissions: .*"contents":"write"/,
  },
  {
    name: "the reusable release build caller drops the read its callee's evidence job needs",
    mutate: (world) => withNamedJob(world, MACOS_RELEASE, "build", (job) => {
      delete job.permissions["pull-requests"];
    }),
    expect: /macos-release\.yml\/build declares `permissions: \{"actions":"read","contents":"read"\}`/,
  },
  {
    name: "the reusable call forwards release material into the CI half",
    mutate: (world) => withNamedJob(world, MACOS_RELEASE, "build", (job) => {
      job.secrets.MACOS_SPARKLE_PRIVATE_KEY = "${{ secrets.MACOS_SPARKLE_PRIVATE_KEY }}";
    }),
    expect: /macos-release\.yml\/build forwards secrets \[.*MACOS_SPARKLE_PRIVATE_KEY/,
  },
  {
    // GitHub rejects the whole workflow for this, and a manual entry point is
    // where that is discovered at the worst possible moment.
    name: "the reusable caller declares a timeout GitHub will reject",
    mutate: (world) => withNamedJob(world, MACOS_RELEASE, "build", (job) => {
      job["timeout-minutes"] = "60";
    }),
    expect: /macos-release\.yml\/build calls a reusable workflow AND declares `timeout-minutes/,
  },
  {
    // The exemption pointed at a job that now runs its own steps.
    name: "the exempted caller job becomes a real job with no bound",
    mutate: (world) => withNamedJob(world, MACOS_RELEASE, "build", (job) => {
      delete job.uses;
      delete job.with;
      delete job.secrets;
      job["runs-on"] = "macos-15";
      job.steps = [{ name: "build", run: "xcodebuild build\n" }];
    }),
    expect: /macos-release\.yml\/build is declared a reusable caller in this policy but its job has no/,
  },
  {
    name: "notarization stops depending on the whole build",
    mutate: (world) => withNamedJob(world, MACOS_RELEASE, "notarize-stage", (job) => {
      delete job.needs;
    }),
    expect: /macos-release\.yml\/notarize-stage declares `needs: undefined`/,
  },
  {
    name: "notarization re-derives the artifact name instead of reading the build's output",
    mutate: (world) => withNamedJob(world, MACOS_RELEASE, "notarize-stage", (job) => {
      const download = job.steps.find((s) => String(s.uses ?? "").startsWith("actions/download-artifact"));
      download.with.name = "relayium-macos-signed-${{ github.sha }}-${{ inputs.release_version || 'ci' }}";
    }),
    expect: /macos-release\.yml\/notarize-stage downloads the artifact named/,
  },
  {
    // A skipped `signed-build` contributes an EMPTY output, and `needs:` is
    // satisfied either way.
    name: "the empty-artifact guard is removed from the notarization job",
    mutate: (world) => withNamedJob(world, MACOS_RELEASE, "notarize-stage", (job) => {
      job.steps = job.steps.filter(
        (step) => !Object.values(step.env ?? {}).some((v) => String(v).includes("needs.build.outputs")),
      );
    }),
    expect: /macos-release\.yml\/notarize-stage has no step that reads/,
  },
  {
    name: "the empty-artifact guard runs after the download it guards",
    mutate: (world) => withNamedJob(world, MACOS_RELEASE, "notarize-stage", (job) => {
      const at = job.steps.findIndex(
        (step) => Object.values(step.env ?? {}).some((v) => String(v).includes("needs.build.outputs")),
      );
      const [guard] = job.steps.splice(at, 1);
      job.steps.push(guard);
    }),
    expect: /AFTER the download at step/,
  },
  {
    name: "the empty-artifact guard reads the value without failing on it",
    mutate: (world) => withNamedJob(world, MACOS_RELEASE, "notarize-stage", (job) => {
      const guard = job.steps.find(
        (step) => Object.values(step.env ?? {}).some((v) => String(v).includes("needs.build.outputs")),
      );
      guard.run = 'echo "artifact is $SIGNED_ARTIFACT"\n';
    }),
    expect: /artifact-name check does not FAIL on an empty value/,
  },
  {
    name: "repository write spreads to a second job in the release workflow",
    mutate: (world) => withNamedJob(world, MACOS_RELEASE, "notarize-stage", (job) => {
      job.permissions = { contents: "write" };
    }),
    expect: /\[notarize-stage, publish\] hold `contents: write`/,
  },
  {
    name: "the Sparkle private key is materialized outside the notarization job",
    mutate: (world) => withNamedJob(world, MACOS_RELEASE, "publish", (job) => {
      job.steps[0].env = { SPARKLE: "${{ secrets.MACOS_SPARKLE_PRIVATE_KEY }}" };
    }),
    expect: /`MACOS_SPARKLE_PRIVATE_KEY` is referenced by \[notarize-stage, publish\]/,
  },
  {
    // Every input defaults to false or empty; a stage that stops asking runs on
    // the dispatch somebody started to get a signed build.
    name: "the notarization stage stops asking whether notarization was requested",
    mutate: (world) => withNamedJob(world, MACOS_RELEASE, "notarize-stage", (job) => {
      job.if = "github.event_name == 'workflow_dispatch'";
    }),
    expect: /macos-release\.yml\/notarize-stage's condition .* no longer reads `inputs\.notarize`/,
  },
  {
    name: "publication stops asking whether publication was requested",
    mutate: (world) => withNamedJob(world, MACOS_RELEASE, "publish", (job) => {
      job.if = "github.event_name == 'workflow_dispatch'";
    }),
    expect: /macos-release\.yml\/publish's condition .* no longer reads `inputs\.publish_release`/,
  },
  {
    // The floor, which moved with the job: below Apple's own `--wait --timeout`
    // a slow-but-succeeding notarization is killed mid-wait and the submission
    // is burned.
    name: "the moved notarization budget drops below Apple's own wait",
    mutate: (world) => withNamedJob(world, MACOS_RELEASE, "notarize-stage", (job) => {
      job["timeout-minutes"] = "40";
    }),
    expect: /macos-release\.yml\/notarize-stage: timeout-minutes is "40", at or below the/,
  },
  // ── exact-main signed-build reuse and PR-free delivery ────────────────────
  {
    name: "the reusable build runs even when the preflight chose reuse",
    mutate: (world) => withNamedJob(world, MACOS_RELEASE, "build", (job) => {
      job.if = "always()";
    }),
    expect: /macos-release\.yml\/build declares needs "preflight" and if "always\(\)"/,
  },
  {
    name: "notarization uses always() and starts on a cancelled release",
    mutate: (world) => withNamedJob(world, MACOS_RELEASE, "notarize-stage", (job) => {
      job.if = job.if.replace("!cancelled()", "always()");
    }),
    expect: /notarize-stage's condition (no longer states `!cancelled\(\)`|uses always\(\))/,
  },
  {
    name: "notarization stops checking that a reuse skipped the build",
    mutate: (world) => withNamedJob(world, MACOS_RELEASE, "notarize-stage", (job) => {
      job.if = job.if.replace(" && needs.build.result == 'skipped'", "");
    }),
    expect: /notarize-stage's condition no longer states `\(needs\.preflight\.outputs\.source == 'reuse' && needs\.build\.result == 'skipped'\)`/,
  },
  {
    name: "notarization materializes the notary key before the package is verified",
    mutate: (world) => withNamedJob(world, MACOS_RELEASE, "notarize-stage", (job) => {
      const at = job.steps.findIndex((step) => step.name === "Materialize notarization API key");
      const [step] = job.steps.splice(at, 1);
      job.steps.splice(1, 0, step);
    }),
    expect: /notarize-stage reaches the first release secret at step 2, before the package verification/,
  },
  {
    name: "the restored generate_appcast runs before the package is verified",
    mutate: (world) => withNamedJob(world, MACOS_RELEASE, "notarize-stage", (job) => {
      const at = job.steps.findIndex((step) => step.name === "Stage public release metadata");
      const [step] = job.steps.splice(at, 1);
      job.steps.splice(2, 0, { ...step, env: { RELEASE_VERSION: "${{ inputs.release_version }}" } });
    }),
    expect: /notarize-stage reaches the first generate_appcast execution at step 3, before the package verification/,
  },
  {
    name: "a reused build is notarized without the fresh readback",
    mutate: (world) => withNamedJob(world, MACOS_RELEASE, "notarize-stage", (job) => {
      job.steps = job.steps.filter((step) => !String(step.run ?? "").includes("macos-evidence.mjs readback"));
    }),
    expect: /notarize-stage must re-prove a reused build/,
  },
  {
    name: "the package verifier becomes conditional",
    mutate: (world) => withNamedJob(world, MACOS_RELEASE, "notarize-stage", (job) => {
      const step = job.steps.find((s) => String(s.run ?? "").includes("macos-evidence-verify-app.sh"));
      step.if = "needs.preflight.outputs.source == 'reuse'";
    }),
    expect: /notarize-stage does not unconditionally run `scripts\/release\/macos-evidence-verify-app\.sh`/,
  },
  {
    name: "the release contract is dropped from the notarization runner",
    mutate: (world) => withNamedJob(world, MACOS_RELEASE, "notarize-stage", (job) => {
      job.steps = job.steps.filter((s) => !String(s.run ?? "").includes("macos-evidence-release-contract.sh"));
    }),
    expect: /notarize-stage must run the release contract unconditionally/,
  },
  {
    name: "the preflight gains a write permission",
    mutate: (world) => withNamedJob(world, MACOS_RELEASE, "preflight", (job) => {
      job.permissions = { actions: "write", contents: "read" };
    }),
    expect: /macos-release\.yml\/preflight declares permissions/,
  },
  {
    name: "publication asks for pull-request write again",
    mutate: (world) => withNamedJob(world, MACOS_RELEASE, "publish", (job) => {
      job.permissions = { ...job.permissions, "pull-requests": "write" };
    }),
    expect: /macos-release\.yml\/publish declares permissions/,
  },
  {
    name: "delivery opens a pull request again",
    mutate: (world) => {
      world.texts.set(MACOS_RELEASE, `${world.texts.get(MACOS_RELEASE)}\n          gh pr create --base main\n`);
      return world;
    },
    expect: /creates a pull request or asks for a pull-request permission again/,
  },
  {
    name: "publication falls back to the implicit success(), which never publishes a reuse",
    mutate: (world) => withNamedJob(world, MACOS_RELEASE, "publish", (job) => {
      job.if = "github.event_name == 'workflow_dispatch' && inputs.publish_release";
    }),
    expect: /publish's condition .* must require `!cancelled\(\)`/,
  },
  {
    name: "the signed-build source gains an unjudged choice",
    mutate: (world) => {
      world.docs.get(MACOS_RELEASE).on.workflow_dispatch.inputs.signed_build_source.options.push("cache");
      return world;
    },
    expect: /dispatch input `signed_build_source` offers/,
  },
  {
    name: "merge-gate's frozen mode stops failing a candidate the judge refuses",
    mutate: (world) => withGateJob(world, "select", (job) => {
      const step = job.steps.find((s) => s.id === "files");
      step.run = step.run.replace(
        'echo "::error::the dispatched commit is not a frozen release-metadata candidate"; exit 1; }',
        'status=frozen-error; }');
    }),
    expect: /a frozen candidate that fails the judge no longer FAILS the selector/,
  },
  {
    name: "merge-gate's frozen judge runs from the candidate's own tree",
    mutate: (world) => withGateJob(world, "select", (job) => {
      const step = job.steps.find((s) => s.id === "files");
      step.run = step.run.replace('node "$judge/scripts/release/macos-evidence.mjs" frozen-candidate',
        "node scripts/release/macos-evidence.mjs frozen-candidate");
    }),
    expect: /no longer runs base's macos-evidence\.mjs frozen-candidate judge/,
  },
  {
    name: "merge-gate's pull-request dispatch mode stops requiring a PR number",
    mutate: (world) => withGateJob(world, "select", (job) => {
      const step = job.steps.find((s) => s.id === "files");
      step.run = step.run.replace('[[ "$PR_NUMBER" =~ ^[1-9][0-9]*$ ]] || status=identity-input-error', ":");
    }),
    expect: /pull-request mode no longer requires a pull request number/,
  },
  {
    name: "merge-gate grows a fourth dispatch mode",
    mutate: (world) => {
      world.docs.get(AGGREGATE).on.workflow_dispatch.inputs.mode.options.push("anything");
      return world;
    },
    expect: /dispatch `mode` must be a required choice/,
  },
  {
    name: "the aggregate stops re-checking the frozen head",
    mutate: (world) => withGateJob(world, "merge-gate", (job) => {
      const step = job.steps.find((s) => String(s.run ?? "").includes("CHECKED_SHA"));
      step.run = step.run.replace('[ "$CHECKED_SHA" != "$EXPECTED_HEAD" ]', "false");
    }),
    expect: /no longer re-checks, where the verdict is given/,
  },
  {
    name: "merge-gate's internal judge runs from the candidate's own tree",
    mutate: (world) => withGateJob(world, "select", (job) => {
      const step = job.steps.find((s) => s.id === "files");
      step.run = step.run.replace('node "$judge/scripts/ci/ci-evidence.mjs" internal-candidate',
        "node scripts/ci/ci-evidence.mjs internal-candidate");
    }),
    expect: /no longer runs base's ci-evidence\.mjs internal-candidate judge/,
  },
  {
    name: "merge-gate's internal judge is no longer a BASE worktree",
    mutate: (world) => withGateJob(world, "select", (job) => {
      const step = job.steps.find((s) => s.id === "files");
      step.run = step.run.replace('judge="$RUNNER_TEMP/internal-base"', 'judge="$GITHUB_WORKSPACE"');
    }),
    expect: /the internal judge no longer runs from BASE's tree/,
  },
  {
    name: "merge-gate's internal mode stops failing a candidate the judge refuses",
    mutate: (world) => withGateJob(world, "select", (job) => {
      const step = job.steps.find((s) => s.id === "files");
      step.run = step.run.replace('echo "::error::the dispatched commit is not an internal full candidate"; exit 1; }',
        "status=internal-error; }");
    }),
    expect: /an internal candidate that fails the judge no longer FAILS the selector/,
  },
  {
    name: "merge-gate's internal mode accepts a judge that wrote no verdict",
    mutate: (world) => withGateJob(world, "select", (job) => {
      const step = job.steps.find((s) => s.id === "files");
      step.run = step.run.replace("grep -qx 'status=internal-full-candidate' \"$RUNNER_TEMP/internal.out\" || {", "true || {");
    }),
    expect: /an internal judge that wrote no verdict no longer fails the selector/,
  },
  {
    name: "the aggregate stops re-checking the internal head and branch",
    mutate: (world) => withGateJob(world, "merge-gate", (job) => {
      const step = job.steps.find((s) => String(s.run ?? "").includes("CHECKED_SHA"));
      step.run = step.run.replace('[ "$GITHUB_REF" != "refs/heads/internal-candidate/$EXPECTED_HEAD" ]', "false");
    }),
    expect: /internal-candidate branch named for it/,
  },
  {
    name: "the aggregate stops requiring every lane of an internal full candidate",
    mutate: (world) => withGateJob(world, "merge-gate", (job) => {
      const step = job.steps.find((s) => String(s.run ?? "").includes("CHECKED_SHA"));
      step.run = step.run.replace('    if [ "$selected" != true ]; then', '    if false; then');
    }),
    expect: /no longer requires an internal full candidate run to have selected every lane/,
  },
  {
    // 6l reaching the BUDGET-ONLY files. Before the split this sweep covered the
    // governed list only, and the release lane is deliberately not governed.
    name: "the release workflow gains a macOS job that RUNNER_BUDGETS covers nowhere",
    mutate: (world) => {
      world.docs.get(MACOS_RELEASE).jobs["mac-extra"] = {
        "runs-on": "macos-15",
        "timeout-minutes": "30",
        steps: [{ name: "extra", run: "xcrun something\n" }],
      };
      return world;
    },
    expect: /macos-release\.yml\/mac-extra runs on "macos-15" — a PAID runner — and section 6i declares no runner-budget ceiling/,
  },
  // -- the aggregate merge gate (6n) and the trigger shape it rests on (1) --
  //
  // Every case here is a one-line edit away from being the real state of the
  // tree, and each leaves the YAML valid, actionlint happy and — this is the
  // whole point — the board GREEN.
  {
    // Without `workflow_call` the gate's `uses:` is unresolvable and the entire
    // run fails to load, so the required context never reports at all.
    name: "a lane stops being callable by the gate",
    mutate: (world) => withoutTrigger(world, WEB, "workflow_call"),
    expect: /web\.yml: `workflow_call` is absent, want present/,
  },
  {
    // The duplicate-run regression, restored. Two identical runs per commit on
    // any branch with an open pull request, both green.
    name: "a lane regains its own pull_request trigger beside the gate's call",
    mutate: (world) => withTrigger(world, "go.yml", "pull_request"),
    expect: /go\.yml: `pull_request` is present, want absent/,
  },
  {
    // S1-G, encoded here because the reasoning lives in `relayium-ops` and
    // nothing in this repository would otherwise stop the cleanup that causes
    // it: a `main` commit with no check run for promotion to read.
    name: "a lane loses the push trigger production promotion reads",
    mutate: (world) => withoutTrigger(world, "contracts.yml", "push"),
    expect: /contracts\.yml: lost its `push` trigger/,
  },
  {
    // A reusable callee keying on the caller's name: one group, one run_id, and
    // lanes cancelling each other under a pull request's cancel-in-progress.
    name: "a called lane keys its concurrency group on github.workflow again",
    mutate: (world) => {
      world.docs.get(IOS).concurrency.group = GROUP;
      return world;
    },
    expect: /ios\.yml: it is a reusable workflow \(`on: workflow_call`\) and its concurrency\.group keys on `github\.workflow`/,
  },
  {
    // Two literals somebody typed, colliding. Every run of one then shares a
    // group with every run of the other.
    name: "two lanes are given the same literal concurrency prefix",
    mutate: (world) => {
      world.docs.get("contracts.yml").concurrency.group = `go-lane-${GROUP_SUFFIX}`;
      return world;
    },
    expect: /both resolve their concurrency group to the prefix "go-lane"/,
  },
  {
    // The invisible one: the lane still runs, still reports, and the aggregate
    // simply stops looking at it.
    name: "a lane is dropped from the aggregate's needs",
    mutate: (world) => withGateJob(world, GATE_JOB, (job) => {
      job.needs = job.needs.filter((name) => name !== "macos");
    }),
    expect: /merge-gate\.yml\/merge-gate depends on \[.*\]; want exactly/,
  },
  {
    // And the other half of the same closure: a lane in `needs:` that nothing
    // calls any more can only ever be skipped.
    name: "a lane stops being called while staying in the aggregate's needs",
    mutate: (world) => {
      delete world.docs.get(AGGREGATE).jobs.ios;
      return world;
    },
    expect: /merge-gate\.yml declares jobs \[.*\]; want exactly/,
  },
  {
    // The whitelist this design rejected, arriving one entry at a time.
    name: "the aggregate starts accepting a failed lane",
    mutate: (world) => withGateRule(
      world,
      "'false:skipped') ;;",
      "'false:skipped') ;;\n              'true:failure') ;;",
    ),
    expect: /accepts the lane result pairings \[.*true:failure.*\]/,
  },
  {
    // The half a `success|skipped` whitelist cannot see: a lane that WAS
    // selected and then got skipped by a broken condition.
    name: "the aggregate starts accepting a selected lane that was skipped",
    mutate: (world) => withGateRule(
      world,
      "'true:success') ;;",
      "'true:success') ;;\n              'true:skipped') ;;",
    ),
    expect: /accepts the lane result pairings \[.*true:skipped.*\]/,
  },
  {
    // The condition stops reading the selection. The lane runs on every pull
    // request, and the aggregate reports it red for not having been selected.
    name: "a lane's condition becomes a constant",
    mutate: (world) => withGateJob(world, "swift-package", (job) => { job.if = "true"; }),
    expect: /merge-gate\.yml\/swift-package declares `if: "true"`/,
  },
  {
    // The hyphen trap, in the direction that is silent: the dotted spelling is
    // parsed as subtraction, so the condition is false forever and the lane
    // never runs while the gate stays green because it reads as "not selected".
    name: "a hyphenated lane's condition is written in dotted form",
    mutate: (world) => withGateJob(world, "native-web-pairing", (job) => {
      job.if = "needs.select.outputs.native-web-pairing == 'true'";
    }),
    expect: /merge-gate\.yml\/native-web-pairing declares `if: "needs\.select\.outputs\.native-web-pairing/,
  },
  {
    // The same trap, in the other declaration of it.
    name: "a hyphenated lane's selector output is published in dotted form",
    mutate: (world) => withGateJob(world, SELECT_JOB, (job) => {
      job.outputs["ops-contract"] = "${{ steps.select.outputs.ops-contract }}";
    }),
    expect: /merge-gate\.yml\/select's `ops-contract` output is .*BRACKET form/,
  },
  {
    // The required context, renamed. Protection then waits on a string nothing
    // reports, and a waiting requirement is not a passing one.
    name: "the aggregate job loses the name the required context is bound to",
    mutate: (world) => withGateJob(world, GATE_JOB, (job) => { delete job.name; }),
    expect: /merge-gate\.yml\/merge-gate declares `name: undefined`/,
  },
  {
    // The substitution the `app_id` binding cannot see, for the new context.
    name: "a second job named merge-gate appears in another workflow",
    mutate: (world) => {
      const text = world.texts.get(AUTO_RELEASE);
      world.texts.set(AUTO_RELEASE, text.replace(
        /^jobs:\s*$/m,
        `jobs:\n  ${GATE_JOB}:\n    runs-on: ubuntu-latest\n    steps:\n      - run: exit 0\n`,
      ));
      return world;
    },
    expect: /also declare a job named `merge-gate`/,
  },
  {
    // Skipped rather than red the moment any lane fails, and a skipped required
    // context is an absent one.
    name: "the aggregate stops running when a lane fails",
    mutate: (world) => withGateJob(world, GATE_JOB, (job) => { delete job.if; }),
    expect: /merge-gate\.yml\/merge-gate declares `if: undefined`, want `always\(\)`/,
  },
  {
    // The unconditional lane gains a condition, and the guards every change
    // must pass acquire a way not to run.
    name: "the unconditional hygiene lane gains a condition",
    mutate: (world) => withGateJob(world, "repo-hygiene", (job) => {
      job.if = "github.actor != 'dependabot[bot]'";
    }),
    expect: /merge-gate\.yml\/repo-hygiene has grown an `if:/,
  },
  {
    // `inherit` on lanes that read no secret at all.
    name: "the gate hands a callee every secret this repository holds",
    mutate: (world) => {
      world.texts.set(AGGREGATE, `${world.texts.get(AGGREGATE)}\n    secrets: inherit\n`);
      return world;
    },
    expect: /merge-gate\.yml uses `secrets: inherit`/,
  },
  {
    // A budget on a `uses:` job, which GitHub rejects outright: the whole run
    // fails to load and the required context never reports.
    name: "a caller job is given a timeout GitHub will reject",
    mutate: (world) => withGateJob(world, "contracts", (job) => { job["timeout-minutes"] = "10"; }),
    expect: /merge-gate\.yml\/contracts declares `timeout-minutes:` on a `uses:` job/,
  },
  {
    // A release lever pulled by an ordinary pull request.
    name: "the gate starts passing inputs to the macOS lane",
    mutate: (world) => withGateJob(world, "macos", (job) => { job.with = { notarize: "true" }; }),
    expect: /merge-gate\.yml\/macos passes `with:/,
  },
  {
    // Release material handed to a lane that reads none.
    name: "a cheap lane is forwarded the signing certificate",
    mutate: (world) => withGateJob(world, "go", (job) => {
      job.secrets = { MACOS_SIGNING_CERT_P12_BASE64: "${{ secrets.MACOS_SIGNING_CERT_P12_BASE64 }}" };
    }),
    expect: /merge-gate\.yml\/go declares `secrets:/,
  },
  {
    // The gate itself behind a path filter: a required context that sometimes
    // does not report blocks every pull request that does not select it.
    name: "the aggregate gains a path filter",
    mutate: (world) => {
      world.docs.get(AGGREGATE).on.pull_request = { paths: ["web/**"] };
      return world;
    },
    expect: /merge-gate\.yml has grown a `pull_request` path filter/,
  },
  {
    // The selector stops running, so every output its conditions read is empty:
    // every lane skipped, and the gate green over a change nothing compiled.
    name: "the selector job stops invoking the selector",
    mutate: (world) => withGateJob(world, SELECT_JOB, (job) => {
      job.steps = job.steps.filter((step) => !String(step?.run ?? "").includes("select-lanes.mjs"));
    }),
    expect: /merge-gate\.yml\/select no longer runs `node scripts\/ci\/select-lanes\.mjs`/,
  },
  {
    // The hardcoded roster drifting away from the jobs it judges.
    name: "the aggregate's hardcoded roster loses a lane",
    mutate: (world) => withGateRule(world, "swift-package inbox-swift-interop", "inbox-swift-interop"),
    expect: /CONDITIONAL_LANES roster is \[.*\]; want \[.*swift-package.*\]/,
  },
  {
    // An always-on lane demoted: it stops being required to SUCCEED and starts
    // being required to be SKIPPED, which is the wrong direction and silent.
    name: "the unconditional roster is emptied",
    mutate: (world) => withGateRule(
      world,
      "UNCONDITIONAL_LANES='compat repo-hygiene'",
      "UNCONDITIONAL_LANES='none'",
    ),
    expect: /UNCONDITIONAL_LANES roster is \["none"\]/,
  },
  // -- compat as the gate's second unconditional lane, and the single entry
  //    point it now has (6o, and the trigger shape in 1) ------------------
  //
  // Every case here leaves the YAML valid and actionlint silent, and all but
  // one leave the board GREEN — which is the point: the damage they describe is
  // a check that stops reporting, a run that gets cancelled, or a gate that
  // quietly checks less, not a red one.
  {
    // The whole reason compat is called unconditionally rather than as a ninth
    // conditional lane: with it demoted out of this roster the aggregate stops
    // requiring it to SUCCEED and starts requiring it to be SKIPPED — and since
    // the lane has no `if:` and always runs, the gate would be red forever, or
    // green forever if the caller were removed alongside.
    name: "the gate stops requiring the compatibility lane to succeed",
    mutate: (world) => withGateRule(
      world,
      "UNCONDITIONAL_LANES='compat repo-hygiene'",
      "UNCONDITIONAL_LANES='repo-hygiene'",
    ),
    expect: /UNCONDITIONAL_LANES roster is \["repo-hygiene"\]/,
  },
  {
    // The lane deleted from the caller side. The wire-compatibility contract
    // stops being part of what the required aggregate judges, and `merge-gate`
    // goes green without it. Since protection edit B this is also the only way
    // a pull request reaches compat at all, so the contract would go unchecked
    // rather than merely unjudged.
    name: "the gate stops calling the compatibility lane at all",
    mutate: (world) => {
      delete world.docs.get(AGGREGATE).jobs.compat;
      return world;
    },
    expect: /merge-gate\.yml declares jobs \[.*\]; want exactly \[.*compat.*\]/,
  },
  {
    // The unconditional half of the no-secrets rule: `compat` runs on every
    // pull request including a fork's.
    name: "an unconditional lane is forwarded the signing certificate",
    mutate: (world) => withGateJob(world, "compat", (job) => {
      job.secrets = { MACOS_SIGNING_CERT_P12_BASE64: "${{ secrets.MACOS_SIGNING_CERT_P12_BASE64 }}" };
    }),
    expect: /merge-gate\.yml\/compat declares `secrets:.*runs UNCONDITIONALLY/s,
  },
  {
    // The same rule on the other unconditional lane, so the loop is proven to
    // cover the roster rather than one entry of it.
    name: "the hygiene lane is forwarded a secret it reads nothing from",
    mutate: (world) => withGateJob(world, "repo-hygiene", (job) => {
      job.secrets = { MACOS_SIGNING_CERT_PASSWORD: "${{ secrets.MACOS_SIGNING_CERT_PASSWORD }}" };
    }),
    expect: /merge-gate\.yml\/repo-hygiene declares `secrets:.*runs UNCONDITIONALLY/s,
  },
  {
    // The gate acquires a condition on the always-on compatibility contract.
    name: "the unconditional compatibility lane gains a condition",
    mutate: (world) => withGateJob(world, "compat", (job) => {
      job.if = "needs.select.outputs['web'] == 'true'";
    }),
    expect: /merge-gate\.yml\/compat has grown an `if:/,
  },
  {
    // The duplicate, restored. This is the edit protection edit B made
    // possible to remove, and the one a future reader is most likely to make
    // "back" out of the belief that compat still owes `main` a bare
    // `wire-vectors` on a pull request. It does not: that check run is owed on
    // `main` commits, and `push: main` below is what provides it.
    name: "compat takes its own direct pull_request trigger back",
    mutate: (world) => withTrigger(world, COMPAT, "pull_request"),
    expect: /compat\.yml: `pull_request` is present, want absent/,
  },
  {
    // The opposite direction, and now the whole board: the gate's `uses:`
    // becomes unresolvable, the ENTIRE aggregate run fails to load, and
    // `merge-gate` reports nothing rather than red. With no direct trigger
    // left, this is also the edit that stops the compatibility contract being
    // checked on pull requests at all.
    name: "compat stops being callable while the gate still calls it",
    mutate: (world) => withoutTrigger(world, COMPAT, "workflow_call"),
    expect: /compat\.yml: `workflow_call` is absent, want present/,
  },
  {
    // The permanent `push: main` trigger, removed. Nothing on a pull request
    // changes and the board stays green — while every `main` commit stops
    // carrying a bare `wire-vectors` check run and `relayium-ops`'
    // `deploy/promote.sh` wedges production promotion with
    // `required check absent`.
    name: "compat loses the push trigger production promotion reads",
    mutate: (world) => withoutTrigger(world, COMPAT, "push"),
    expect: /compat\.yml: lost its `push` trigger/,
  },
  {
    // `push` kept, but no longer restricted to `main`.
    name: "compat's push trigger is widened past main",
    mutate: (world) => {
      world.docs.get(COMPAT).on.push.branches = ["main", "release/**"];
      return world;
    },
    expect: /compat\.yml: `push\.branches` is \["main","release\/\*\*"\], want exactly \["main"\]/,
  },
  {
    // The manual entry point, removed. It is the only way to re-run this gate
    // against a `main` commit whose check run was lost, which is what the
    // promotion path reads.
    name: "compat loses the manual dispatch that can re-report a main commit",
    mutate: (world) => withoutTrigger(world, COMPAT, "workflow_dispatch"),
    expect: /compat\.yml: workflow_dispatch is absent, want present/,
  },
  {
    // The input surface, reopened — under a NEW name, which is why the rule
    // bans the surface rather than one spelling. Nothing about the YAML looks
    // wrong, and the gate has acquired a lever every caller can pull.
    name: "compat regains a workflow_call input, under a name nothing used before",
    mutate: (world) => {
      world.docs.get(COMPAT).on.workflow_call = {
        inputs: {
          skip_vectors: { required: "false", default: "false", type: "boolean" },
        },
      };
      return world;
    },
    expect: /compat\.yml's `workflow_call` declares inputs \[skip_vectors\]; want NONE/,
  },
  {
    // And the transitional input specifically, put back exactly as it was. It
    // was legitimate for one migration step and is not legitimate now: there is
    // one entry point left for it to discriminate.
    name: "compat regains the transitional concurrency discriminator input",
    mutate: (world) => {
      world.docs.get(COMPAT).on.workflow_call = {
        inputs: {
          concurrency_scope: { required: "false", default: "merge-gate", type: "string" },
        },
      };
      return world;
    },
    expect: /compat\.yml's `workflow_call` declares inputs \[concurrency_scope\]; want NONE/,
  },
  {
    // The lever one level down, and it does not need a declared input to work:
    // an undeclared read evaluates to the empty string, so this compiles, runs,
    // and lets the gate skip itself for a caller.
    name: "compat starts reading a caller-supplied input inside a job",
    mutate: (world) => withNamedJob(world, COMPAT, COMPAT_JOB, (job) => {
      job.if = "inputs.skip_vectors != 'true'";
    }),
    expect: /compat\.yml: a job reads `inputs\.skip_vectors`/,
  },
  {
    // The discriminator returning in the group. Harmless-looking, and it can
    // only be there to tell apart an entry point section 1 forbids.
    name: "compat's concurrency group regains a call-vs-direct discriminator",
    mutate: (world) => {
      const doc = world.docs.get(COMPAT);
      doc.concurrency.group =
        `compat-\${{ inputs.concurrency_scope || 'direct' }}-${GROUP_SUFFIX}`;
      return world;
    },
    expect: /compat\.yml: concurrency\.group is ".*" and reads an `inputs\.` term/,
  },
  {
    // The literal prefix, replaced by something that is not it. Section 2's
    // exact-string rule fires too; this case exists so the REASON — a called
    // lane needs a literal nothing else uses — is proven able to fail on its
    // own wording.
    name: "compat's concurrency group loses its literal lane prefix",
    mutate: (world) => {
      world.docs.get(COMPAT).concurrency.group = `compat-${GROUP_SUFFIX}`;
      return world;
    },
    expect: /compat\.yml: concurrency\.group is "compat-.*", which does not start with the literal prefix `compat-lane-`/,
  },
  {
    // Caller and callee in one group: the deadlock, not the cancellation.
    name: "compat is given the aggregate's own concurrency prefix",
    mutate: (world) => {
      world.docs.get(COMPAT).concurrency.group = `merge-gate-${GROUP_SUFFIX}`;
      return world;
    },
    expect: /compat\.yml and merge-gate\.yml share the concurrency prefix "merge-gate"/,
  },
  {
    // The suffix half of the repository-wide rule. Without the `github.run_id`
    // fallback every `main` push and every dispatch of this file shares one
    // group, and GitHub cancels an older PENDING run in a group even with
    // cancel-in-progress false — so the `main` commit that promotion reads gets
    // a CANCELLED check rather than a green one.
    name: "compat's concurrency group loses its run_id fallback",
    mutate: (world) => {
      world.docs.get(COMPAT).concurrency.group =
        `${COMPAT_GROUP_PREFIX}-\${{ github.event.pull_request.number }}`;
      return world;
    },
    expect: /compat\.yml: concurrency\.group has no `github\.run_id` fallback/,
  },
  {
    // The cancel policy, widened past pull requests. A `main` run could then be
    // superseded by the next `main` run, and the superseded commit's
    // `wire-vectors` check run reports `cancelled` — which promotion reads as
    // not-green on a commit that was never actually checked.
    name: "compat starts cancelling its own main runs",
    mutate: (world) => {
      world.docs.get(COMPAT).concurrency["cancel-in-progress"] = "true";
      return world;
    },
    expect: /compat\.yml: concurrency\.cancel-in-progress is "true", want/,
  },
  // ── 6p: the iOS upload toolchain ─────────────────────────────────────────
  //
  // Every case below leaves `ios.yml` a valid workflow GitHub would run happily,
  // and every one puts the lane back to reporting green for a build Apple
  // refuses at upload.
  {
    name: "an iOS job moves off the image this gate's inventory claim is about",
    mutate: (world) => withNamedJob(world, IOS_TRANSFER_INTEROP, "ios-transfer-acceptance", (job) => {
      job["runs-on"] = "macos-latest";
    }),
    expect: /ios-transfer-interop\.yml\/ios-transfer-acceptance: `runs-on` is "macos-latest", want "macos-15"/,
  },
  {
    // Down, to the runner image default. The classic direction.
    name: "the required Xcode major is lowered to the image default's",
    mutate: (world) => { world.docs.get(IOS).env[XCODE_MAJOR_KEY] = "16"; return world; },
    expect: /ios\.yml: `env\.RELAYIUM_XCODE_MAJOR` is "16", want exactly 26/,
  },
  {
    // And UP: the direction a floor cannot see, and why this is an equality.
    // Bumping to the preview `macos-15` carries reads like keeping current,
    // compiles, passes every job — and is discovered at upload, against a
    // build number already consumed.
    name: "the required Xcode major is raised to the preview the image carries",
    mutate: (world) => { world.docs.get(IOS).env[XCODE_MAJOR_KEY] = "27"; return world; },
    expect: /ios\.yml: `env\.RELAYIUM_XCODE_MAJOR` is "27", want exactly 26/,
  },
  {
    name: "the iOS SDK floor is lowered below Apple's",
    mutate: (world) => { world.docs.get(IOS).env[SDK_MIN_KEY] = "18"; return world; },
    expect: /ios\.yml: `env\.RELAYIUM_MIN_IOS_SDK_MAJOR` is "18", want an integer of at least 26/,
  },
  {
    name: "the shared selection script itself is removed",
    mutate: (world) => { delete world.docs.get(IOS).env[SELECT_KEY]; return world; },
    expect: /ios\.yml: `env\.RELAYIUM_SELECT_XCODE` is missing or empty/,
  },
  {
    name: "an iOS job loses the shared Xcode selection step",
    mutate: (world) => withIosGuard(world, "ios-ui-smoke", (steps, at) => {
      steps.splice(at, 1);
    }),
    expect: /ios\.yml\/ios-ui-smoke: no step runs the shared Xcode selection/,
  },
  {
    // The subtle one: the step is present, runs, prints a correct version and
    // passes — after the build it governs already compiled against 16.4.
    name: "the Xcode selection runs after the build it governs",
    mutate: (world) => withIosGuard(world, "ios-build", (steps, at) => {
      const [guard] = steps.splice(at, 1);
      steps.push(guard);
    }),
    expect: /ios\.yml\/ios-build: the Xcode selection step runs AFTER/,
  },
  {
    // The three ways to keep a step that still MATCHES the shared reference and
    // still cannot report red. Each leaves the workflow valid and the lane
    // green, building against the 16.4 default the script exists to refuse.
    name: "the Xcode selection swallows its own failure with `|| true`",
    mutate: (world) => withIosGuard(world, "ios-build", (steps, at) => {
      steps[at] = { ...steps[at], run: `${steps[at].run} || true` };
    }),
    expect: /ios\.yml\/ios-build: the Xcode selection step runs .*want exactly/,
  },
  {
    name: "the Xcode selection is marked `continue-on-error`",
    mutate: (world) => withIosGuard(world, "ios-ui-smoke", (steps, at) => {
      steps[at] = { ...steps[at], "continue-on-error": true };
    }),
    expect: /ios\.yml\/ios-ui-smoke: the Xcode selection step sets `continue-on-error: true`/,
  },
  {
    // The same bypass spelled as a string, which GitHub honours identically and
    // a `!== true` predicate reads as safe.
    name: "the Xcode selection is marked `continue-on-error` as a quoted string",
    mutate: (world) => withNamedJob(world, IOS, "ios-build", (job) => {
      job["continue-on-error"] = "true";
    }),
    expect: /ios\.yml\/ios-build: the Xcode selection job sets `continue-on-error: "true"`/,
  },
  {
    name: "the Xcode selection is made conditional and skips",
    mutate: (world) => withIosGuard(world, "ios-build", (steps, at) => {
      steps[at] = { ...steps[at], if: "false" };
    }),
    expect: /ios\.yml\/ios-build: the Xcode selection step carries `if:/,
  },
  {
    // Selection that reaches no later step: the gate passes, the builds below
    // it use the image default anyway.
    name: "the shared script stops exporting DEVELOPER_DIR to later steps",
    mutate: (world) => withIosScript(world, (script) => script.replace(
      /\n[^\n]*DEVELOPER_DIR=[^\n]*>>[^\n]*GITHUB_ENV[^\n]*\n/,
      "\n",
    )),
    expect: /does not export `DEVELOPER_DIR` through/,
  },
  {
    // Back to newest-wins. Both numbers still declared and read, the enumeration
    // still runs and prints — and the filter that kept the Xcode 27 preview out
    // of the running is gone. It reads as a simplification.
    name: "the shared script goes back to selecting the globally newest Xcode",
    mutate: (world) => withoutIosScriptBlock(world, /^\s*if \[ "\$major" !=/, "required-major"),
    expect: /never restricts selection to the required Xcode major/,
  },
  {
    // The likelier near miss: the filter survives as a FLOOR. "At least 26"
    // reads as safer than "exactly 26" and is the rule that selects the preview.
    name: "the required-major filter is relaxed back into a floor",
    mutate: (world) => withIosScript(world, (script) => script.replace(
      /"\$major" != "\$required_xcode"/,
      '"$major" -lt "$required_xcode"',
    )),
    expect: /never restricts selection to the required Xcode major/,
  },
  {
    // The second place a wrong major dies. Removing it is invisible while the
    // in-loop filter is intact, which is why it is asserted separately.
    name: "the shared script stops re-asserting the selected major after the loop",
    mutate: (world) => withoutIosScriptBlock(
      world, /^\s*if \[ "\$selected_major" !=/, "selected-major assertion",
    ),
    expect: /never re-asserts the SELECTED major after the loop/,
  },
  {
    // "Nothing survived" is a REACHABLE state once selection filters to one
    // major, and walking past it exports an empty `DEVELOPER_DIR` — not an
    // error downstream, just a silent return to the runner default.
    name: "the shared script stops failing closed when no Xcode 26 is installed",
    mutate: (world) => withoutIosScriptBlock(world, /-z "\$selected" \]; then$/, "empty-selection"),
    expect: /does not fail closed on an empty selection/,
  },
  {
    // The refusal deleted while the predicate implementing it stays in the file.
    // Nothing looks incomplete afterwards: it enumerates, filters, selects.
    name: "the shared script stops refusing explicitly marked prerelease bundles",
    mutate: (world) => withoutIosScriptBlock(world, /^\s*if prerelease /, "prerelease refusal"),
    expect: /never REFUSES a candidate carrying an explicit prerelease marker/,
  },
  {
    name: "the shared script drops its beta match",
    mutate: (world) => withIosScript(world, (script) => script.replace("*beta*|", "")),
    expect: /carries no `\*beta\*` match/,
  },
  {
    name: "the shared script stops reading the iphoneos SDK version",
    mutate: (world) => withIosScript(world, (script) => script.replace(
      /xcrun --sdk iphoneos --show-sdk-version/,
      "xcodebuild -showsdks",
    )),
    expect: /never reads the iphoneos SDK version/,
  },
  {
    name: "the iphoneos SDK comparison is dropped from the shared script",
    mutate: (world) => withoutIosScriptBlock(world, /-lt\s+"\$min_sdk"/, "iOS SDK floor"),
    expect: /never compares the iphoneos SDK against `RELAYIUM_MIN_IOS_SDK_MAJOR`/,
  },
  {
    // The override that beats the export: a YAML `env:` wins over `$GITHUB_ENV`,
    // so the selection step passes while the build uses 16.4.
    name: "a job pins DEVELOPER_DIR back to the image default",
    mutate: (world) => withNamedJob(world, IOS, "ios-build", (job) => {
      job.env = { DEVELOPER_DIR: "/Applications/Xcode.app/Contents/Developer" };
    }),
    expect: /ios\.yml\/ios-build overrides `DEVELOPER_DIR`/,
  },
  {
    name: "a step re-selects a toolchain after the gate",
    mutate: (world) => withNamedJob(world, IOS, "ios-build", (job) => {
      job.steps.push({
        name: "Use the fallback toolchain",
        run: "sudo xcode-select -s /Library/Developer/CommandLineTools\n",
      });
    }),
    expect: /runs `xcode-select`/,
  },
  {
    // The opposite obligation. The step's NAME is prose: rewording it must not
    // fail anything, or the next person to improve it learns to stop.
    name: "the Xcode selection step is renamed",
    mutate: (world) => withIosGuard(world, "ios-build", (steps, at) => {
      steps[at] = { ...steps[at], name: "Pick the toolchain Apple accepts" };
    }),
    refute: /no step runs the shared Xcode selection|Xcode selection step runs AFTER/,
  },
  // The two cases that used to sit here — `macos.yml`'s unfiltered `swift test`
  // gaining a `--filter`, and a legitimate fast pre-check beside it — moved
  // with their rule to `scripts/test/swift-ci-boundary-test.mjs`, which now
  // owns where that command may live and mutates both shapes there.
  // ── 6k: the app-tree guards run on a change to the tree they read ─────────
  {
    // The retired step, put back. It reads as extra safety and is a second
    // package build for an answer the package lane already gives.
    name: "ios.yml grows a filtered swift test back",
    mutate: (world) => {
      world.docs.get(IOS).jobs["ios-build"].steps.push({
        name: "guards",
        "working-directory": "apps/RelayiumKit",
        run: "swift test --filter 'RelayiumKitTests.IOSSurfaceGuardTests'\n",
      });
      return world;
    },
    expect: /ios\.yml runs `swift test` in \[ios-build\/"guards"\]/,
  },
  {
    name: "macos.yml grows a swift test of its own",
    mutate: (world) => {
      world.docs.get(MACOS).jobs.test.steps.push({
        name: "guards",
        "working-directory": "apps/RelayiumKit",
        run: "swift test --filter 'RelayiumKitTests.MacSurfaceGuardTests'\n",
      });
      return world;
    },
    expect: /macos\.yml runs `swift test` in \[test\/"guards"\]/,
  },
  {
    // The package lane narrowed to the Mac PROJECT alone: the project sample
    // keeps passing while every plist and source guard loses its runner.
    name: "swift-package.yml narrows its Mac entry to the project file",
    mutate: (world) => withPaths(world, "swift-package.yml", [
      "apps/RelayiumKit/**", "apps/mac/Relayium.xcodeproj/**", "apps/ios/**",
      ".github/workflows/swift-package.yml",
    ]),
    expect: /swift-package\.yml does not trigger on apps\/mac\/Relayium\/Info\.plist/,
  },
  {
    // The narrowing that keeps the project-file sample passing and takes every
    // declaration change out of the lane. It reads as a tightening — two
    // precise globs instead of one broad one — and it is how the guards added
    // here stop running without a single selector being touched.
    name: "ios.yml's filter is narrowed to the project and Swift sources only",
    mutate: (world) => withPaths(world, IOS, [
      "apps/ios/Relayium.xcodeproj/**",
      "apps/ios/Relayium/*.swift",
      "apps/RelayiumKit/**",
      "!apps/RelayiumKit/Tests/**",
      `.github/workflows/${IOS}`,
    ]),
    expect: /ios\.yml does not trigger on apps\/ios\/Relayium\/Info\.plist/,
  },
  {
    name: "ios.yml stops watching the Share extension the guards bound",
    mutate: (world) => withPaths(world, IOS, [
      "apps/ios/Relayium/**",
      "apps/ios/Relayium.xcodeproj/**",
      "apps/RelayiumKit/**",
      "!apps/RelayiumKit/Tests/**",
      `.github/workflows/${IOS}`,
    ]),
    expect: /ios\.yml does not trigger on apps\/ios\/RelayiumShare\/ShareViewController\.swift/,
  },
  {
    // The other side of the same claim, since the package lane adopted the two
    // app trees on purpose: it is what runs EVERY guard that reads `apps/ios`,
    // so narrowing it back off that tree is the edit that must fail.
    name: "swift-package.yml drops the iOS app tree it watches for its guards",
    mutate: (world) => withPaths(world, "swift-package.yml", [
      "apps/RelayiumKit/**", "apps/mac/**", ".github/workflows/swift-package.yml",
    ]),
    expect: /swift-package\.yml does not trigger on apps\/ios\//,
  },
  {
    // 6b's exception is exact in BOTH directions. Dropping `apps/mac/**` is the
    // gap this filter closed — `macos.yml` runs no `swift test` — and…
    name: "swift-package.yml drops the Mac app tree, whose guards no other lane runs",
    mutate: (world) => withPaths(world, "swift-package.yml", [
      "apps/RelayiumKit/**", "apps/ios/**", ".github/workflows/swift-package.yml",
    ]),
    expect: /swift-package\.yml's path filter matches platform roots \[apps\/ios\]; want exactly \[apps\/mac, apps\/ios\]/,
  },
  {
    // …a third root is the whole Swift suite on a macOS runner for a tree no
    // Swift test opens. The exception is not a licence to span platforms.
    name: "swift-package.yml spans a third platform root under cover of its exception",
    mutate: (world) => withPaths(world, "swift-package.yml", [
      "apps/RelayiumKit/**", "apps/mac/**", "apps/ios/**", "apps/android/**",
      ".github/workflows/swift-package.yml",
    ]),
    expect: /swift-package\.yml's path filter matches platform roots \[apps\/mac, apps\/ios, apps\/android\]; want exactly/,
  },
  {
    // And the exception is for ONE file. Any other workflow spanning two roots
    // still fails the original rule.
    name: "another workflow spans two platform roots, which only the package lane may",
    mutate: (world) => withPaths(world, "macos.yml", [
      "apps/mac/**", "apps/ios/**", "apps/RelayiumKit/**", "!apps/RelayiumKit/Tests/**",
      ".github/workflows/macos.yml",
    ]),
    expect: /macos\.yml's path filter matches more than one platform root \(apps\/mac, apps\/ios\)/,
  },
  // ── 6q: the regular-width shell job ──────────────────────────────────────
  //
  // Every case below leaves a job that runs, passes and reports green while
  // executing none of the regular-width cases it exists for.
  {
    name: "the iPad regular-width job is deleted",
    mutate: (world) => {
      delete world.docs.get(IOS).jobs[IOS_REGULAR_WIDTH_JOB];
      return world;
    },
    expect: /ios\.yml declares no `ios-ipad-shell` job/,
  },
  {
    // The one-word regression. The job keeps its name, its comment and its
    // scope, boots a compact simulator, and every case skips.
    name: "the iPad job's destination drifts back to an iPhone",
    mutate: (world) => withNamedJob(world, IOS, IOS_REGULAR_WIDTH_JOB, (job) => {
      // The selection lives in the boot step since 6v; the program is unchanged.
      const step = job.steps.find((entry) => String(entry?.run ?? "").includes('startswith("iPad")'));
      step.run = String(step.run).replace(/"iPad"/g, '"iPhone"');
    }),
    expect: /ios\.yml\/ios-ipad-shell: a step names `iPhone`/,
  },
  {
    // The prefix filter dropped altogether: `startswith("")` is true of every
    // simulator, so the sorted pick becomes whatever the image lists first.
    name: "the iPad job stops filtering its destination by name",
    mutate: (world) => withNamedJob(world, IOS, IOS_REGULAR_WIDTH_JOB, (job) => {
      const step = job.steps.find((entry) => String(entry?.run ?? "").includes('startswith("iPad")'));
      step.run = String(step.run).replace(/"iPad"/g, '""');
    }),
    expect: /no step selects its simulator by an `iPad` name at all/,
  },
  {
    // "Stronger gate", spelled as a second full paid UI run.
    name: "the iPad job is widened to the whole UI target",
    mutate: (world) => withNamedJob(world, IOS, IOS_REGULAR_WIDTH_JOB, (job) => {
      const step = job.steps.find((entry) => String(entry?.run ?? "").includes("xcodebuild"));
      step.run = String(step.run)
        .replace("-only-testing:RelayiumUITests/AdaptiveShellUITests test",
          "-only-testing:RelayiumUITests test");
    }),
    expect: /passes `-only-testing:RelayiumUITests test`, the whole UI target/,
  },
  {
    name: "the iPad job adopts a class that already runs on the iPhone job",
    mutate: (world) => withNamedJob(world, IOS, IOS_REGULAR_WIDTH_JOB, (job) => {
      const step = job.steps.find((entry) => String(entry?.run ?? "").includes("xcodebuild"));
      step.run = String(step.run)
        .replace("-only-testing:RelayiumUITests/AdaptiveShellUITests test",
          "-only-testing:RelayiumUITests/AdaptiveShellUITests \\\n"
          + "            -only-testing:RelayiumUITests/LocalSessionUITests test");
    }),
    expect: /a step selects `RelayiumUITests\/LocalSessionUITests`/,
  },
  {
    // Prose is not selection. Commenting the line out leaves every word this
    // section looks for present in the file.
    name: "the iPad job's scope survives only as a comment",
    mutate: (world) => withNamedJob(world, IOS, IOS_REGULAR_WIDTH_JOB, (job) => {
      const step = job.steps.find((entry) => String(entry?.run ?? "").includes("xcodebuild"));
      step.run = String(step.run)
        .split("\n")
        .map((line) => (line.includes(IOS_REGULAR_WIDTH_SELECTOR) ? `# ${line.trim()}` : line))
        .join("\n");
    }),
    expect: /no step passes `-only-testing:RelayiumUITests\/AdaptiveShellUITests`/,
  },
  {
    // The silent one: `xcodebuild` runs zero tests for an identifier that
    // resolves to nothing and exits 0.
    name: "the regular-width class is renamed out from under -only-testing",
    mutate: (world) => {
      world.uiTestClasses = world.uiTestClasses.filter((name) => name !== IOS_REGULAR_WIDTH_CLASS);
      return world;
    },
    expect: /apps\/ios\/RelayiumUITests declares no such class/,
  },
  {
    // The check that makes this job different from the state it replaces, read
    // as "tidying up a step that always passes".
    name: "the iPad job stops asserting its cases were not skipped",
    mutate: (world) => withNamedJob(world, IOS, IOS_REGULAR_WIDTH_JOB, (job) => {
      job.steps = job.steps.filter((step) => !String(step?.run ?? "").includes("skippedTests"));
    }),
    expect: /no step reads `skippedTests` out of the result bundle/,
  },
  {
    // And the half of that proof a skip check alone cannot make: zero of zero
    // skipped is zero skipped.
    name: "the iPad job asserts no skips but not that anything ran",
    mutate: (world) => withNamedJob(world, IOS, IOS_REGULAR_WIDTH_JOB, (job) => {
      const step = job.steps.find((entry) => String(entry?.run ?? "").includes("totalTestCount"));
      step.run = String(step.run).replace(/totalTestCount/g, "passedTests");
    }),
    expect: /no step requires the run to have executed any test at all/,
  },
  {
    name: "the iPad job stops retaining its result bundle",
    mutate: (world) => withNamedJob(world, IOS, IOS_REGULAR_WIDTH_JOB, (job) => {
      job.steps = job.steps.filter((step) => !String(step?.uses ?? "").includes("upload-artifact"));
    }),
    expect: /ios\.yml\/ios-ipad-shell: nothing uploads the result bundle/,
  },
  {
    name: "the iPad job's diagnosis upload loses its failure condition",
    mutate: (world) => withNamedJob(world, IOS, IOS_REGULAR_WIDTH_JOB, (job) => {
      const step = job.steps.find((entry) => String(entry?.uses ?? "").includes("upload-artifact"));
      delete step.if;
    }),
    expect: /the result-bundle upload declares `if: undefined`/,
  },
  {
    name: "the iPad job's diagnosis upload goes back to a bare failure()",
    mutate: (world) => withNamedJob(world, IOS, IOS_REGULAR_WIDTH_JOB, (job) => {
      const step = job.steps.find((entry) => String(entry?.uses ?? "").includes("upload-artifact"));
      step.if = `${EV_FULL} && (failure() || (always() && steps.ipad_shell.outcome == 'cancelled'))`;
    }),
    expect: /a bare `failure\(\)` uploads a bundle that does not exist/,
  },
  {
    name: "the iPad job is serialized behind the build job",
    mutate: (world) => withNamedJob(world, IOS, IOS_REGULAR_WIDTH_JOB, (job) => {
      job.needs = "ios-build";
    }),
    expect: /ios\.yml\/ios-ipad-shell declares `needs: "ios-build"`/,
  },
  {
    // The legitimate shape. A prose line inside the run body explaining why
    // this job is not the compact one names the device it is not, and that is
    // not a destination — a check that fired here would be rewritten until it
    // fired on nothing.
    name: "the iPad job's run body explains, in a comment, which shape it is not",
    mutate: (world) => withNamedJob(world, IOS, IOS_REGULAR_WIDTH_JOB, (job) => {
      const step = job.steps.find((entry) => String(entry?.run ?? "").includes("xcodebuild"));
      step.run = `# not an iPhone: every case here skips on a compact shell\n${step.run}`;
    }),
    refute: /a step names `iPhone`/,
  },
  // ── 6u: the iPhone UI target's two complementary shards ──────────────────
  //
  // Every case below leaves both shards running and green while some part of
  // the UI target runs twice, runs nowhere, or runs without evidence.
  {
    name: "the iPhone UI matrix loses its complement shard",
    mutate: (world) => withNamedJob(world, IOS, IOS_COMPACT_JOB, (job) => {
      job.strategy.matrix.shard = ["app-shell"];
    }),
    expect: /ios\.yml\/ios-ui-smoke: matrix is .*want exactly `shard: \[app-shell, complement\]`/,
  },
  {
    name: "the iPhone UI matrix grows a third shard",
    mutate: (world) => withNamedJob(world, IOS, IOS_COMPACT_JOB, (job) => {
      job.strategy.matrix.shard = [...job.strategy.matrix.shard, "extra"];
    }),
    expect: /ios\.yml\/ios-ui-smoke: matrix is .*another PAID macOS runner per run/,
  },
  {
    name: "the iPhone UI shards go back to cancelling each other",
    mutate: (world) => withNamedJob(world, IOS, IOS_COMPACT_JOB, (job) => {
      delete job.strategy["fail-fast"];
    }),
    expect: /ios\.yml\/ios-ui-smoke: strategy\.fail-fast is undefined, want false/,
  },
  {
    // The branch is gone, the matrix entry is not: the complement job starts,
    // falls to `*)` and fails — but the partition must name the lost classes.
    name: "the complement shard's selection branch is deleted",
    mutate: (world) => withIosUiSmokeRun(world, (run) => run.replace(/complement\)\n/, "retired)\n")),
    expect: /ios\.yml\/ios-ui-smoke: RelayiumUITests\/LocalSessionUITests is selected by no shard/,
  },
  {
    name: "the complement shard loses its -skip-testing exclusion",
    mutate: (world) => withIosUiSmokeRun(world, (run) => run
      .replace("selection=(-skip-testing:RelayiumUITests/AppShellUITests\n", "selection=(\n")),
    expect: /RelayiumUITests\/AppShellUITests is selected by both shards \[app-shell, complement\]/,
  },
  {
    // Prose is not selection: the exclusion survives only as a comment.
    name: "the complement's exclusion survives only as a comment",
    mutate: (world) => withIosUiSmokeRun(world, (run) => run
      .replace(/([ \t]*)selection=\((-skip-testing:RelayiumUITests\/AppShellUITests\n)/, "$1selection=(\n$1  # $2")),
    expect: /RelayiumUITests\/AppShellUITests is selected by both shards/,
  },
  {
    name: "the app-shell shard is widened to the whole target",
    mutate: (world) => withIosUiSmokeRun(world, (run) => run
      .replace("-only-testing:RelayiumUITests/AppShellUITests)", "-only-testing:RelayiumUITests)")),
    expect: /is selected by both shards \[app-shell, complement\]/,
  },
  {
    // Green today, wrong tomorrow: the complement spelled as today's classes.
    name: "the complement is written as a hand-kept class list",
    mutate: (world) => withIosUiSmokeRun(world, (run) => run.replace(
      /-skip-testing:RelayiumUITests\/AppShellUITests\n([ \t]*)-only-testing:RelayiumUITests\)/,
      (_, indent) => world.uiTestClasses.filter((name) => name !== IOS_COMPACT_BOUNDARY_CLASS)
        .map((name) => `-only-testing:RelayiumUITests/${name}`).join(`\n${indent}`) + ")",
    )),
    expect: /the `complement` shard selects only .*Naming the remaining classes instead/,
  },
  {
    // The same hand-kept list, the day after a class is added.
    name: "a class is added while the complement is a hand-kept list",
    mutate: (world) => {
      withIosUiSmokeRun(world, (run) => run.replace(
        /-skip-testing:RelayiumUITests\/AppShellUITests\n([ \t]*)-only-testing:RelayiumUITests\)/,
        (_, indent) => world.uiTestClasses.filter((name) => name !== IOS_COMPACT_BOUNDARY_CLASS)
          .map((name) => `-only-testing:RelayiumUITests/${name}`).join(`\n${indent}`) + ")",
      ));
      world.uiTestClasses = [...world.uiTestClasses, "NewlyAddedUITests"];
      return world;
    },
    expect: /RelayiumUITests\/NewlyAddedUITests is selected by no shard/,
  },
  {
    // The legitimate shape: a new class lands in the complement with no edit.
    name: "a new UI test class is added to the target",
    mutate: (world) => {
      world.uiTestClasses = [...world.uiTestClasses, "NewlyAddedUITests"];
      return world;
    },
    refute: /ios\.yml\/ios-ui-smoke/,
  },
  {
    name: "the boundary class is renamed out from under both shards",
    mutate: (world) => {
      world.uiTestClasses = world.uiTestClasses.filter((name) => name !== IOS_COMPACT_BOUNDARY_CLASS);
      return world;
    },
    expect: /the shards split at `AppShellUITests`, but apps\/ios\/RelayiumUITests declares no such class/,
  },
  {
    name: "a shard narrows to a single test method",
    mutate: (world) => withIosUiSmokeRun(world, (run) => run
      .replace("-only-testing:RelayiumUITests/AppShellUITests)",
        "-only-testing:RelayiumUITests/AppShellUITests/testLaunch)")),
    expect: /a method-level identifier is a partition this policy cannot evaluate/,
  },
  {
    name: "an unknown shard falls through instead of failing",
    mutate: (world) => withIosUiSmokeRun(world, (run) => run.replace(/exit 1\n([ \t]*;;\n[ \t]*esac)/, "true\n$1")),
    expect: /the default `\*\)` branch does not exit non-zero/,
  },
  {
    name: "the shard proof is deleted",
    mutate: (world) => withNamedJob(world, IOS, IOS_COMPACT_JOB, (job) => {
      job.steps = job.steps.filter((step) => step?.id !== IOS_COMPACT_PROOF_ID);
    }),
    expect: /no step after the test has `id: ui_shard_proof`/,
  },
  {
    // Empty execution: zero of zero is not a failure to a class check alone.
    name: "the shard proof stops requiring that anything ran",
    mutate: (world) => withNamedJob(world, IOS, IOS_COMPACT_JOB, (job) => {
      const step = job.steps.find((entry) => entry?.id === IOS_COMPACT_PROOF_ID);
      step.run = String(step.run).replace(/totalTestCount/g, "expectedFailures");
    }),
    expect: /the shard proof does not require both `totalTestCount` and `passedTests`/,
  },
  {
    name: "the shard proof accepts an all-skipped shard",
    mutate: (world) => withNamedJob(world, IOS, IOS_COMPACT_JOB, (job) => {
      const step = job.steps.find((entry) => entry?.id === IOS_COMPACT_PROOF_ID);
      step.run = String(step.run).replace(/passedTests/g, "skippedTests");
    }),
    expect: /the shard proof does not require both `totalTestCount` and `passedTests`/,
  },
  {
    name: "the shard proof stops reading which classes ran",
    mutate: (world) => withNamedJob(world, IOS, IOS_COMPACT_JOB, (job) => {
      const step = job.steps.find((entry) => entry?.id === IOS_COMPACT_PROOF_ID);
      step.run = String(step.run).replace(/test-results tests/g, "test-results summary");
    }),
    expect: /the shard proof does not read the executed cases' classes/,
  },
  {
    name: "both shards upload their diagnosis under one artifact name",
    mutate: (world) => withNamedJob(world, IOS, IOS_COMPACT_JOB, (job) => {
      const step = job.steps.find((entry) => String(entry?.uses ?? "").includes("upload-artifact"));
      step.with.name = "ios-ui-smoke-diagnosis";
    }),
    expect: /the diagnosis artifact is named "ios-ui-smoke-diagnosis", which does not carry/,
  },
  {
    name: "a failed shard proof keeps no result bundle",
    mutate: (world) => withNamedJob(world, IOS, IOS_COMPACT_JOB, (job) => {
      const step = job.steps.find((entry) => String(entry?.uses ?? "").includes("upload-artifact"));
      step.if = String(step.if).replace(/ \|\| always\(\) && steps\.ui_shard_proof\.outcome == 'failure'/, "");
    }),
    expect: /the diagnosis upload does not run when the shard proof fails/,
  },
  {
    name: "the iPad job is sharded too",
    mutate: (world) => withNamedJob(world, IOS, IOS_REGULAR_WIDTH_JOB, (job) => {
      job.strategy = { "fail-fast": "false", matrix: { shard: ["app-shell", "complement"] } };
    }),
    expect: /ios\.yml\/ios-ipad-shell gained a `strategy`/,
  },
  {
    // Changed iPad: the complement's shape copied onto the regular-width job.
    name: "the iPad job adopts the complement selection",
    mutate: (world) => withNamedJob(world, IOS, IOS_REGULAR_WIDTH_JOB, (job) => {
      const step = job.steps.find((entry) => String(entry?.run ?? "").includes("xcodebuild"));
      step.run = String(step.run).replace("-only-testing:RelayiumUITests/AdaptiveShellUITests test",
        "-skip-testing:RelayiumUITests/AppShellUITests \\\n            -only-testing:RelayiumUITests test");
    }),
    expect: /ios\.yml\/ios-ipad-shell: a step passes `-only-testing:RelayiumUITests test`, the whole UI target/,
  },
  {
    name: "the shard count budgeted for the iPhone UI job is raised",
    mutate: (world) => {
      const budget = RUNNER_BUDGETS.find((b) => b.file === IOS).jobs[IOS_COMPACT_JOB];
      const saved = budget.shards;
      budget.shards = 3;
      try { return { ...world, __budgetFailures: iosCompactShardFailures(world) }; } finally { budget.shards = saved; }
    },
    expect: /ios\.yml\/ios-ui-smoke: this policy budgets 3 runner\(s\) per run for this job, want 2/,
  },
  {
    // 6t. A release input the expression forgets: the step still reaches its
    // release branch, now on Ubuntu, where the guard fails the release.
    name: "macos.yml contract's runs-on forgets publish_release",
    mutate: (world) => withNamedJob(world, MACOS, "contract", (job) => {
      job["runs-on"] = job["runs-on"].replace(" || inputs.publish_release", "");
    }),
    expect: /macos\.yml\/contract \(push version="" notarize=false publish=true\): the step reaches its release branch, but runs-on picks "ubuntu-latest"/,
  },
  {
    // 6t. Notarize alone is release intent: forgetting it in the expression
    // leaves the branch reachable on Ubuntu, where the guard fails the release.
    name: "macos.yml contract's runs-on forgets notarize",
    mutate: (world) => withNamedJob(world, MACOS, "contract", (job) => {
      job["runs-on"] = job["runs-on"].replace(" || inputs.notarize", "");
    }),
    expect: /macos\.yml\/contract \(push version="" notarize=true publish=false\): the step reaches its release branch, but runs-on picks "ubuntu-latest"/,
  },
  {
    // 6t. The shell forgets notarize: the expression still pays for macOS but
    // the branch never runs — intent without its checks.
    name: "macos.yml contract's release branch forgets notarize",
    mutate: (world) => withNamedJob(world, MACOS, "contract", (job) => {
      const step = job.steps.find((s) => s.name === CONTRACT_STEP);
      step.run = step.run.replace('if [ -n "$RELEASE_VERSION" ] || [ "$NOTARIZE" = true ] \\\n', 'if [ -n "$RELEASE_VERSION" ] \\\n');
    }),
    expect: /macos\.yml\/contract \(push version="" notarize=true publish=false\): a release intent picks "macos-15" and never reaches the release branch/,
  },
  {
    // 6t. THE GAP: the caller's event comes back into the expression, and a
    // dispatched merge gate (no inputs) queues for macOS again.
    name: "macos.yml contract's runs-on reads the caller's event again",
    mutate: (world) => withNamedJob(world, MACOS, "contract", (job) => {
      job["runs-on"] = job["runs-on"].replace("(inputs.release_version", "(github.event_name == 'workflow_dispatch' || inputs.release_version");
    }),
    expect: /macos\.yml\/contract \(workflow_dispatch with no inputs\): an ordinary run picks "macos-15"/,
  },
  {
    // 6t. The shell `if` grows the event back: a dispatched gate reaches the
    // release branch on Ubuntu, and the guard fails it.
    name: "macos.yml contract's release branch reads the caller's event again",
    mutate: (world) => withNamedJob(world, MACOS, "contract", (job) => {
      const step = job.steps.find((s) => s.name === CONTRACT_STEP);
      step.run = step.run.replace('if [ -n "$RELEASE_VERSION" ]', 'if [ "$GITHUB_EVENT_NAME" = workflow_dispatch ] || [ -n "$RELEASE_VERSION" ]');
    }),
    expect: /macos\.yml\/contract \(workflow_dispatch with no inputs\): the step reaches its release branch, but runs-on picks "ubuntu-latest"/,
  },
  {
    // 6t. Each original release check keeps its refusal: notarize no longer required for a version.
    name: "macos.yml contract no longer requires notarize for a version",
    mutate: (world) => withNamedJob(world, MACOS, "contract", (job) => {
      const step = job.steps.find((s) => s.name === CONTRACT_STEP);
      step.run = step.run.replace(/^ *\[ "\$NOTARIZE" = true \] \|\| exit 1\n/m, "");
    }),
    expect: /macos\.yml\/contract \(a version without notarize\): on macOS the step must refuse/,
  },
  {
    // 6t. The version-format check is gone.
    name: "macos.yml contract no longer checks the version format",
    mutate: (world) => withNamedJob(world, MACOS, "contract", (job) => {
      const step = job.steps.find((s) => s.name === CONTRACT_STEP);
      step.run = step.run.replace(/^ *printf '%s' "\$RELEASE_VERSION" \| grep -Eq .*\n/m, "");
    }),
    expect: /macos\.yml\/contract \(invalid version format\): on macOS the step must refuse/,
  },
  {
    // 6t. The MARKETING_VERSION match is gone.
    name: "macos.yml contract no longer matches MARKETING_VERSION",
    mutate: (world) => withNamedJob(world, MACOS, "contract", (job) => {
      const step = job.steps.find((s) => s.name === CONTRACT_STEP);
      step.run = step.run.replace(/^ *\[ "\$actual" = "\$RELEASE_VERSION" \] .*\n/m, "");
    }),
    expect: /macos\.yml\/contract \(a version that is not MARKETING_VERSION\): on macOS the step must refuse/,
  },
  {
    // 6t. Publication from a non-main ref is no longer refused.
    name: "macos.yml contract publishes from any ref",
    mutate: (world) => withNamedJob(world, MACOS, "contract", (job) => {
      const step = job.steps.find((s) => s.name === CONTRACT_STEP);
      step.run = step.run.replace(' && [ "$GITHUB_REF" = refs/heads/main ]', "");
    }),
    expect: /macos\.yml\/contract \(publish from a branch other than main\): on macOS the step must refuse/,
  },
  {
    // 6t. Without the guard, a Linux run that reaches the branch calls xcodebuild.
    name: "macos.yml contract loses its non-macOS runner guard",
    mutate: (world) => withNamedJob(world, MACOS, "contract", (job) => {
      const step = job.steps.find((s) => s.name === CONTRACT_STEP);
      step.run = step.run.replace(/^ *\[ "\$RUNNER_OS" = macOS \].*\n/m, "");
    }),
    expect: /macos\.yml\/contract \(push version="1\.4\.5" notarize=true publish=false\): run as Linux, the release-contract step called \[xcodebuild/,
  },
  {
    // 6t. The optimisation itself: ordinary runs stop queueing for macOS.
    name: "macos.yml contract goes back to macos-15 for every run",
    mutate: (world) => withNamedJob(world, MACOS, "contract", (job) => { job["runs-on"] = "macos-15"; }),
    expect: /macos\.yml\/contract \(push with no inputs\): an ordinary run picks "macos-15"/,
  },
  {
    // 6t. An expression the evaluator does not model is refused, not guessed.
    name: "macos.yml contract's runs-on reads a context 6t does not model",
    mutate: (world) => withNamedJob(world, MACOS, "contract", (job) => {
      job["runs-on"] = job["runs-on"].replace("inputs.notarize", "github.event.action");
    }),
    expect: /macos\.yml\/contract: cannot evaluate runs-on/,
  },
  {
    // 6t. The release branch's own checks survive the move: a renamed readiness
    // check on the macOS publish run is noticed.
    name: "macos.yml contract's publish branch drops the readiness check",
    mutate: (world) => withNamedJob(world, MACOS, "contract", (job) => {
      const step = job.steps.find((s) => s.name === CONTRACT_STEP);
      step.run = step.run.replace(/^ *node apps\/mac\/scripts\/check-release-readiness\.mjs --require-approved\n/m, "");
    }),
    expect: /macos\.yml\/contract \(push version="1\.4\.5" notarize=true publish=true\): on macOS the step must pass, read MARKETING_VERSION and run the readiness check/,
  },
  {
    // 6l. A conditional runs-on that can pick macOS is still a paid job.
    name: "macos.yml contract's conditional runner loses its runner-budget entry",
    mutate: (world) => {
      const budget = RUNNER_BUDGETS.find((b) => b.file === MACOS);
      const saved = budget.jobs.contract;
      delete budget.jobs.contract;
      try { return { ...world, __budgetFailures: macosBudgetFailures(world) }; } finally { budget.jobs.contract = saved; }
    },
    expect: /macos\.yml\/contract runs on .*a PAID runner/,
  },
];

for (const { name, mutate, expect, refute } of MUTATIONS) {
  let got;
  try {
    const world = mutate(realWorld());
    got = [
      ...triggerFailures(world),
      ...platformBoundaryFailures(world),
      ...pathMatrixFailures(world),
      ...fuzzCampaignFailures(world),
      ...iosParallelLaneFailures(world),
      ...appGuardCoverageFailures(world),
      ...iosRegularWidthShellFailures(world),
      ...iosCompactShardFailures(world),
      ...macosBudgetFailures(world),
      ...macosContractRunnerFailures(world),
      ...(world.__budgetFailures ?? []),
      ...concurrencyFailures(world),
      ...releaseBoundaryFailures(world),
      ...aggregateGateFailures(world),
      ...compatEntryPointFailures(world),
      ...iosUploadToolchainFailures(world),
    ];
  } catch (err) {
    check(false, `the CI trigger-policy mutation "${name}" threw instead of reporting: ${err.message}`);
    continue;
  }
  const rendered = got.length === 0 ? "no failures at all" : `[\n    ${got.join("\n    ")}\n  ]`;
  if (expect) {
    check(
      got.some((message) => expect.test(message)),
      `the CI trigger policy did NOT complain about "${name}". Expected a message matching `
      + `${expect}; got ${rendered}. `
      + `A check that cannot fail for the reason it was written is not a check, and this one would `
      + `report green while the boundary it names is already gone.`,
    );
  }
  // The opposite obligation. A boundary that fires on shapes which are actually
  // fine gets widened until it fires on nothing, so the false positive and the
  // missing check have the same destination.
  if (refute) {
    check(
      !got.some((message) => refute.test(message)),
      `the CI trigger policy complained about "${name}", which is a legitimate shape. `
      + `Expected NO message matching ${refute}; got ${rendered}.`,
    );
  }
}

// ── 6v. both iOS UI jobs boot their simulator behind a bounded barrier ───────
//
// II's complement shard compiled, signed, and then lost its runner before the
// first test case: XCTDaemonError 19, AXDisableAccessibilityOnTermination,
// kAXErrorCannotComplete. Nothing in the job had waited for the simulator it
// had just picked; `xcodebuild` booted it on demand inside the 48-minute test
// step. The repair is a separate preparation step per UI job that runs the
// job's own, unchanged selection program, then `xcrun simctl bootstatus
// "$device_id" -b` — which boots the device if it is not booted and returns
// once it has FINISHED booting — under its own 5-minute bound, and hands the
// device to the test step only after that succeeded.
//
// It is a boot barrier, not a cure. It makes no claim that the accessibility
// services UI testing needs are up, and none that a run is faster. What it
// guarantees, and what is held here:
//
//   * the barrier exists, targets the selected device, and passes `-b`;
//   * a boot that fails, or never finishes, fails the preparation step, hands
//     nothing on, and the test step — with no status function in its `if` —
//     is skipped instead of spending its budget;
//   * the selection rules are the ones the toolchain registry pins (iPhone:
//     first in the listing; iPad: sorted (name, runtime, udid)), and neither
//     job falls back to the other kind;
//   * the test step refuses an empty or malformed device before `xcodebuild`,
//     and drives exactly the device that was booted;
//   * the job bound covers its step bounds in order, so the preparation step's
//     ceiling cannot be paid for out of the test step's.
//
// The structural half below is checked on every mutation in section 8. The
// executable half runs the workflow's own step scripts with stub `xcrun` and
// `xcodebuild`, once for the real files and once per mutation in 8v.

/** The iPad UI job: its preparation step, its test step, and the device kind. The iPhone job no longer has a
 *  separate preparation step: its selection, boot barrier and build run in ONE supervised stage (6v-iPhone). */
const IOS_BOOT_JOBS = [
  { job: IOS_REGULAR_WIDTH_JOB, prep: "ipad_sim", test: "ipad_shell", kind: "iPad", other: "iPhone", shard: "" },
];
const IOS_BOOT_PREP_MAX_MINUTES = 5;
const IOS_BOOT_BARRIER = 'xcrun simctl bootstatus "$device_id" -b';
const IOS_BOOT_HANDOVER = 'echo "device_id=$device_id" >> "$GITHUB_OUTPUT"';

function iosSimulatorBootFailures(world) {
  const out = [];
  const need = (ok, message) => { if (!ok) out.push(message); };
  const doc = world.docs.get(IOS);
  if (!doc) return out;
  for (const { job: jobId, prep, test } of IOS_BOOT_JOBS) {
    const job = doc.jobs?.[jobId];
    if (!job) continue; // a missing job is reported by its own section
    const where = `${IOS}/${jobId}`;
    const steps = job.steps ?? [];
    const prepAt = steps.findIndex((s) => s?.id === prep);
    const testAt = steps.findIndex((s) => s?.id === test);
    need(prepAt !== -1,
      `${where}: no step has \`id: ${prep}\`, so nothing boots the selected simulator before \`xcodebuild\` `
      + `and a slow or failed boot is spent inside the test step's budget.`);
    if (prepAt === -1 || testAt === -1) continue;
    const prepStep = steps[prepAt];
    const testStep = steps[testAt];
    const prepRun = String(prepStep.run ?? "").split("\n").filter((l) => !/^\s*#/.test(l)).join("\n");
    const testRun = String(testStep.run ?? "").split("\n").filter((l) => !/^\s*#/.test(l)).join("\n");
    need(prepAt < testAt, `${where}: the \`${prep}\` step runs after the \`${test}\` step it prepares.`);
    // Read from the full-path view (6x), where an original step's evidence guard
    // is already unwrapped: no condition here means exactly the guard there,
    // and 6x holds the adopted file to that canonical form.
    need(prepStep.if === undefined,
      `${where}: the \`${prep}\` step's condition is ${JSON.stringify(prepStep.if)}, want none on the full path `
      + `(only the evidence guard). A condition here can skip the barrier while the test step still runs.`);
    const minutes = Number(prepStep["timeout-minutes"]);
    need(Number.isInteger(minutes) && minutes > 0 && minutes <= IOS_BOOT_PREP_MAX_MINUTES,
      `${where}: the \`${prep}\` step's timeout-minutes is ${JSON.stringify(prepStep["timeout-minutes"])}, want an `
      + `integer in 1..${IOS_BOOT_PREP_MAX_MINUTES}. Without its own bound a boot that never finishes holds the PAID `
      + `runner until the job times out (reported \`cancelled\`).`);
    need(prepStep["continue-on-error"] === undefined && testStep["continue-on-error"] === undefined,
      `${where}: the \`${prep}\` or \`${test}\` step sets \`continue-on-error\`, so a failed boot no longer stops `
      + `the job before \`xcodebuild\`.`);
    need(prepRun.split(IOS_BOOT_BARRIER).length === 2,
      `${where}: the \`${prep}\` step does not run \`${IOS_BOOT_BARRIER}\` exactly once. That command is the `
      + `barrier: it boots the selected device if needed and returns only once the boot finished.`);
    need(!/\bsimctl\s+boot\b/.test(prepRun) && !/\bsleep\b/.test(prepRun),
      `${where}: the \`${prep}\` step boots separately or sleeps. A separate \`simctl boot\` invites ignoring its `
      + `"already booted" error, and a sleep is a guess where the barrier is a fact.`);
    const barrierAt = prepRun.indexOf(IOS_BOOT_BARRIER);
    const handoverAt = prepRun.indexOf(IOS_BOOT_HANDOVER);
    need(handoverAt !== -1 && barrierAt !== -1 && handoverAt > barrierAt,
      `${where}: the \`${prep}\` step does not hand the device on (\`${IOS_BOOT_HANDOVER}\`) after the barrier, `
      + `so the test step could receive a device whose boot never succeeded.`);
    need(testStep.if === undefined,
      `${where}: the \`${test}\` step's condition is ${JSON.stringify(testStep.if)}, want none on the full path `
      + `(only the evidence guard). Any status function there (\`always()\`, \`failure()\`) runs \`xcodebuild\` `
      + `after the boot failed.`);
    need(String(testStep.env?.DEVICE_ID ?? "") === `\${{ steps.${prep}.outputs.device_id }}`,
      `${where}: the \`${test}\` step does not receive \`DEVICE_ID: \${{ steps.${prep}.outputs.device_id }}\`, so `
      + `it does not drive the device the barrier booted.`);
    need(!/simctl\s+list/.test(testRun),
      `${where}: the \`${test}\` step selects a simulator itself, so it can drive a device that was never booted.`);
    const jobMinutes = Number(job["timeout-minutes"]);
    const bounded = steps.slice(0, testAt + 1).reduce((sum, s) => sum + (Number(s?.["timeout-minutes"]) || 0), 0);
    need(Number.isFinite(jobMinutes) && jobMinutes >= bounded,
      `${where}: the job's timeout-minutes ${JSON.stringify(job["timeout-minutes"])} is below the ${bounded} minutes `
      + `its steps up to \`${test}\` may take in order, so a slow Xcode selection or boot would be paid for out of `
      + `the test step's budget and end as a job timeout.`);
  }
  return out;
}

/** A simulator in a `simctl list devices available -j` listing. */
const bootUdid = (n) => `0000000${n}-AAAA-BBBB-CCCC-DDDDEEEEFFF${n}`;
const bootDev = (name, n) => ({ name, udid: bootUdid(n), isAvailable: true, state: "Shutdown" });
const BOOT_RT_NEW = "com.apple.CoreSimulator.SimRuntime.iOS-26-0";
const BOOT_RT_OLD = "com.apple.CoreSimulator.SimRuntime.iOS-18-5";
/** Newer runtime first and not in name order, so the two rules disagree. */
const BOOT_LISTING = {
  devices: {
    [BOOT_RT_NEW]: [bootDev("iPad Pro 13-inch (M4)", 1), bootDev("iPhone 17 Pro", 2), bootDev("iPhone 17", 3)],
    [BOOT_RT_OLD]: [bootDev("iPad Air 11-inch (M2)", 4), bootDev("iPhone 16", 5)],
  },
};
const BOOT_LISTING_REORDERED = { devices: Object.fromEntries(Object.entries(BOOT_LISTING.devices).reverse()) };
const bootOnly = (kind) => ({
  devices: Object.fromEntries(Object.entries(BOOT_LISTING.devices)
    .map(([rt, list]) => [rt, list.filter((d) => d.name.startsWith(kind))])),
});
/** What each rule picks: [listing, iPhone pick, iPad pick] (null: must refuse). */
const BOOT_CASES = [
  ["listing", BOOT_LISTING, { iPhone: [2, "iPhone 17 Pro", BOOT_RT_NEW], iPad: [4, "iPad Air 11-inch (M2)", BOOT_RT_OLD] }],
  // The iPhone rule is first-in-listing by design (and pinned so): reordering
  // the listing moves its answer. The iPad rule is sorted: it does not move.
  ["reordered listing", BOOT_LISTING_REORDERED, { iPhone: [5, "iPhone 16", BOOT_RT_OLD], iPad: [4, "iPad Air 11-inch (M2)", BOOT_RT_OLD] }],
  ["no iPhone available", bootOnly("iPad"), { iPhone: null, iPad: [4, "iPad Air 11-inch (M2)", BOOT_RT_OLD] }],
  ["no iPad available", bootOnly("iPhone"), { iPhone: [2, "iPhone 17 Pro", BOOT_RT_NEW], iPad: null }],
];
const BOOT_UTC = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z/;

/**
 * Run both UI jobs' preparation and test steps, as written, against stub
 * `xcrun`/`xcodebuild`. Every run is bounded here (a stub boot that "hangs"
 * sleeps briefly with its output detached and is killed at the bound), and the
 * scratch directory is removed before returning. The hang case waits out its
 * bound, so it runs for the real workflow only; no 8v mutation targets it.
 */
function iosSimulatorBootExecutionFailures(world, { hang = true } = {}) {
  const out = [];
  const need = (ok, message) => { if (!ok) out.push(message); };
  const doc = world.docs.get(IOS);
  if (!doc) return out;
  const dir = spawnSync("mktemp", ["-d", `${process.env.TMPDIR ?? "/tmp"}/ios-boot.XXXXXX`], { encoding: "utf8" }).stdout.trim();
  if (!dir) return ["6v: could not create a scratch directory for the iOS boot fixtures."];
  try {
    const xcrun = [
      "#!/bin/bash",
      'echo "xcrun $*" >> "$TOOL_CALLS"',
      'if [ "$1 $2 $3 $4" = "simctl list devices available" ]; then cat "$BOOT_LISTING_FILE"; exit 0; fi',
      // The iPad listing runs as `xcrun --log …`, a timing diagnostic: xcrun names
      // the command it invokes on stderr. Exactly that argv and nothing looser —
      // any other option (`--find`, `--verbose`, …) still falls through and fails.
      'if [ "$#" -eq 6 ] && [ "$1 $2 $3 $4 $5 $6" = "--log simctl list devices available -j" ]; then',
      '  echo "/fake/Xcode.app/Contents/Developer/usr/bin/simctl list devices available -j" >&2',
      '  cat "$BOOT_LISTING_FILE"; exit 0',
      'fi',
      'if [ "$1 $2" = "simctl bootstatus" ]; then',
      '  case "$BOOT_MODE" in',
      '    ok) echo "Device already booted, nothing to do."; exit 0 ;;',
      '    fail) echo "Unable to boot device" >&2; exit 149 ;;',
      '    hang) exec sleep 6 </dev/null >/dev/null 2>&1 ;;',
      '  esac',
      'fi',
      'echo "unexpected xcrun call: $*" >&2; exit 2',
      "",
    ].join("\n");
    const xcodebuild = '#!/bin/bash\necho "xcodebuild $*" >> "$TOOL_CALLS"\nexit 0\n';
    spawnSync("bash", ["-c", 'mkdir -p "$1/bin" && printf "%s" "$2" > "$1/bin/xcrun" && printf "%s" "$3" > "$1/bin/xcodebuild" '
      + '&& chmod +x "$1/bin/xcrun" "$1/bin/xcodebuild"', "_", dir, xcrun, xcodebuild]);
    let n = 0;
    const run = (script, { listing = BOOT_LISTING, mode = "ok", env = {}, bound = 20000 } = {}) => {
      n += 1;
      const calls = `${dir}/calls-${n}`;
      const output = `${dir}/output-${n}`;
      spawnSync("bash", ["-c", `printf '%s' "$1" > "${dir}/listing-${n}.json" && printf '%s' "$2" > "${dir}/step-${n}.sh" && : > "${calls}" && : > "${output}"`,
        "_", JSON.stringify(listing), script]);
      const r = spawnSync("bash", ["-e", `${dir}/step-${n}.sh`], {
        encoding: "utf8",
        timeout: bound,
        killSignal: "SIGKILL",
        env: {
          PATH: `${dir}/bin:${process.env.PATH}`, TOOL_CALLS: calls, BOOT_LISTING_FILE: `${dir}/listing-${n}.json`,
          BOOT_MODE: mode, GITHUB_OUTPUT: output, RUNNER_TEMP: dir, ...env,
        },
      });
      const read = (f) => spawnSync("cat", [f], { encoding: "utf8" }).stdout ?? "";
      return { status: r.status, signal: r.signal, log: `${r.stdout ?? ""}${r.stderr ?? ""}`, calls: read(calls), output: read(output) };
    };
    const boots = (calls) => calls.split("\n").filter((l) => l.startsWith("xcrun simctl bootstatus"));
    for (const { job: jobId, prep, test, kind, shard } of IOS_BOOT_JOBS) {
      const steps = doc.jobs?.[jobId]?.steps ?? [];
      const prepStep = steps.find((s) => s?.id === prep);
      const testStep = steps.find((s) => s?.id === test);
      const where = `${IOS}/${jobId}`;
      if (typeof prepStep?.run !== "string" || typeof testStep?.run !== "string") {
        need(false, `${where}: no \`${prep}\` and \`${test}\` steps with run scripts to execute.`);
        continue;
      }
      for (const [label, listing, picks] of BOOT_CASES) {
        const want = picks[kind];
        const r = run(prepStep.run, { listing });
        if (want === null) {
          need(r.status !== 0 && boots(r.calls).length === 0 && r.output === "",
            `${where} (${label}): with no available ${kind} the \`${prep}\` step must fail before any boot and hand `
            + `nothing on; got exit ${r.status}, boots [${boots(r.calls)}], output ${JSON.stringify(r.output)}. A `
            + `${kind} job that boots another kind instead duplicates a run at full price, or skips every case.`);
          continue;
        }
        const [k, name, runtime] = want;
        const udid = bootUdid(k);
        need(r.status === 0,
          `${where} (${label}): the \`${prep}\` step failed on a listing with an available ${kind}; exit ${r.status}.\n${r.log}`);
        need(boots(r.calls).length === 1 && boots(r.calls)[0] === `xcrun simctl bootstatus ${udid} -b`,
          `${where} (${label}): the \`${prep}\` step ran boot barriers [${boots(r.calls).join(" | ")}]; want exactly `
          + `\`xcrun simctl bootstatus ${udid} -b\` — the device the job's own rule selects (${name}, ${runtime}).`);
        need(r.output === `device_id=${udid}\n`,
          `${where} (${label}): the \`${prep}\` step handed on ${JSON.stringify(r.output)}; want exactly "device_id=${udid}".`);
        need(r.log.includes(name) && r.log.includes(runtime) && r.log.includes(udid)
          && /Boot started/.test(r.log) && /Boot finished .* after \d+s/.test(r.log)
          && (r.log.match(new RegExp(BOOT_UTC.source, "g")) ?? []).length >= 2,
          `${where} (${label}): the \`${prep}\` step's log does not name the selected model, runtime and UDID and the `
          + `UTC start/finish of the boot with its elapsed time.\n${r.log}`);
      }
      if (kind === "iPad") {
        // The diagnostic option is accepted by exact argv only: the same listing
        // under any other xcrun option is refused and fails the step closed.
        const logged = "xcrun --log simctl list devices available -j";
        need(prepStep.run.split(logged).length === 2,
          `${where}: the \`${prep}\` step does not list through \`${logged}\` exactly once.`);
        for (const option of ["--verbose", "--find"]) {
          const other = run(prepStep.run.replace(logged, logged.replace("--log", option)));
          need(other.status !== 0 && boots(other.calls).length === 0 && other.output === ""
            && other.log.includes(`unexpected xcrun call: ${option} simctl list devices available -j`),
            `${where}: the \`${prep}\` listing under \`xcrun ${option}\` was not refused by the stub; got exit `
            + `${other.status}, boots [${boots(other.calls)}], output ${JSON.stringify(other.output)}.`);
        }
      }
      const udid = bootUdid(kind === "iPhone" ? 2 : 4);
      const failed = run(prepStep.run, { mode: "fail" });
      need(failed.status !== 0 && failed.output === "",
        `${where}: a failing \`simctl bootstatus\` must fail the \`${prep}\` step and hand nothing on; got exit `
        + `${failed.status}, output ${JSON.stringify(failed.output)}. A swallowed boot failure lets \`xcodebuild\` `
        + `drive a device that never booted.`);
      const hung = hang ? run(prepStep.run, { mode: "hang", bound: 1500 }) : { status: 1, output: "" };
      need(hung.status !== 0 && hung.output === "",
        `${where}: a boot that never finishes must not hand the device on before the step's bound ends it; got exit `
        + `${hung.status} (signal ${hung.signal}), output ${JSON.stringify(hung.output)}.`);
      const testEnv = { UI_SHARD: shard };
      const ran = run(testStep.run, { env: { ...testEnv, DEVICE_ID: udid } });
      const builds = ran.calls.split("\n").filter((l) => l.startsWith("xcodebuild "));
      need(ran.status === 0 && builds.length === 1
        && builds[0].includes(`-destination platform=iOS Simulator,id=${udid} `) && / test$/.test(builds[0]),
        `${where}: given DEVICE_ID ${udid}, the \`${test}\` step ran [${builds.join(" | ")}] (exit ${ran.status}); want `
        + `one \`xcodebuild … test\` whose destination is exactly that device.`);
      for (const bad of ["", "booted", udid.toLowerCase(), `${udid}x`]) {
        const refused = run(testStep.run, { env: { ...testEnv, DEVICE_ID: bad } });
        need(refused.status !== 0 && !refused.calls.includes("xcodebuild"),
          `${where}: given DEVICE_ID ${JSON.stringify(bad)}, the \`${test}\` step ran xcodebuild or passed `
          + `(exit ${refused.status}); want a refusal before \`xcodebuild\`.`);
      }
    }
  } finally {
    spawnSync("rm", ["-rf", dir]);
  }
  return out;
}

for (const message of iosSimulatorBootFailures(realWorld())) failures.push(message);
for (const message of iosSimulatorBootExecutionFailures(realWorld())) failures.push(message);

// ── 8v. each way the boot barrier silently stops being one ──────────────────
//
// Each mutation edits the parsed workflow and must be reported, by the
// structural half or by actually running the edited step, for its own reason.

/** Edit one step's run script of one UI job; throws when the edit did not apply. */
function withBootStepRun(world, jobId, stepId, edit) {
  const step = world.docs.get(IOS)?.jobs?.[jobId]?.steps?.find((s) => s?.id === stepId);
  if (step === undefined) throw new Error(`${IOS}/${jobId} has no ${stepId} step`);
  const before = String(step.run);
  step.run = edit(before);
  if (step.run === before) throw new Error(`${IOS}/${jobId}: the ${stepId} mutation did not apply`);
  return world;
}
function withBootStep(world, jobId, stepId, edit) {
  const step = world.docs.get(IOS)?.jobs?.[jobId]?.steps?.find((s) => s?.id === stepId);
  if (step === undefined) throw new Error(`${IOS}/${jobId} has no ${stepId} step`);
  edit(step);
  return world;
}

const BOOT_MUTATIONS = [
  {
    name: "the iPad boot failure is swallowed",
    mutate: (w) => withBootStepRun(w, IOS_REGULAR_WIDTH_JOB, "ipad_sim", (r) => r.replace(IOS_BOOT_BARRIER, `${IOS_BOOT_BARRIER} || true`)),
    expect: /ios-ipad-shell: a failing `simctl bootstatus` must fail the `ipad_sim` step and hand nothing on/,
  },
  {
    name: "the iPad device is handed on before its boot succeeded",
    mutate: (w) => withBootStepRun(w, IOS_REGULAR_WIDTH_JOB, "ipad_sim", (r) => {
      const lines = r.split("\n");
      const at = lines.indexOf(IOS_BOOT_HANDOVER);
      const [handover] = lines.splice(at, 1);
      lines.splice(lines.indexOf(IOS_BOOT_BARRIER), 0, handover);
      return lines.join("\n");
    }),
    expect: /ios-ipad-shell: a failing `simctl bootstatus` must fail the `ipad_sim` step and hand nothing on; got exit \d+, output "device_id=/,
  },
  {
    name: "the iPad selection falls back to an iPhone",
    mutate: (w) => withBootStepRun(w, IOS_REGULAR_WIDTH_JOB, "ipad_sim", (r) => r.replace('.startswith("iPad"))', '.startswith(("iPad", "Phone", "iPhone")))')),
    expect: /ios-ipad-shell \(no iPad available\): with no available iPad the `ipad_sim` step must fail before any boot/,
  },
  {
    name: "the iPad preparation loses its bound",
    mutate: (w) => withBootStep(w, IOS_REGULAR_WIDTH_JOB, "ipad_sim", (s) => { delete s["timeout-minutes"]; }),
    expect: /ios-ipad-shell: the `ipad_sim` step's timeout-minutes is undefined, want an integer in 1\.\.5/,
  },
  {
    name: "the iPad test step drives a device other than the booted one",
    mutate: (w) => withBootStepRun(w, IOS_REGULAR_WIDTH_JOB, "ipad_shell", (r) => r.replace('device_id="$DEVICE_ID"', `device_id="${bootUdid(9)}"`)),
    expect: /ios-ipad-shell: given DEVICE_ID 00000004-AAAA-BBBB-CCCC-DDDDEEEEFFF4, the `ipad_shell` step ran \[xcodebuild .*id=00000009/,
  },
];

for (const { name, mutate, expect } of BOOT_MUTATIONS) {
  let got;
  try {
    const world = mutate(realWorld());
    got = [...iosSimulatorBootFailures(world), ...iosSimulatorBootExecutionFailures(world, { hang: false })];
  } catch (err) {
    check(false, `the iOS boot mutation "${name}" threw instead of reporting: ${err.message}`);
    continue;
  }
  check(got.some((message) => expect.test(message)),
    `the iOS boot barrier check did NOT complain about "${name}". Expected a message matching ${expect}; got `
    + `${got.length === 0 ? "no failures at all" : `[\n    ${got.join("\n    ")}\n  ]`}.`);
}

// ── 6v-iPhone. the iPhone shard: one supervised stage, selection → boot ∥ build → test ──
//
// The iPhone job no longer boots in a separate step. Its `ui_smoke` step hands the job's own selection script
// (a quoted heredoc; the pinned program, hashed by this step's name in the toolchain registry) to
// scripts/ci/ios-ui-smoke.py, which supervises selection, then `xcrun simctl bootstatus UDID -b` and `xcodebuild …
// build-for-testing` together, then `test-without-building` only after BOTH succeeded — under the original 300 s
// (selection + boot), 2880 s (build + test) and a 3170 s stage inside the original 53 minutes. What is held here:
//
//   * there is no separate iPhone preparation step and nothing is handed through step outputs;
//   * the step is the original one (name, id, evidence guard only, 53 minutes, no continue-on-error), and the job
//     bound still covers the step bounds in order;
//   * the step passes its OWN inline arrays and the selection heredoc to the helper, and runs no xcodebuild or
//     bootstrap itself;
//   * executed against stub tools: the selected device is booted exactly once, built for testing exactly once and
//     tested exactly once, the test starts only after the boot and the build both ENDED, a missing iPhone or a
//     failed boot/build runs no test, and nothing is written to GITHUB_OUTPUT;
//   * the helper's own process, budget and cleanup behaviour is owned by scripts/test/ios-ui-smoke-test.py, which
//     repo-hygiene runs; its trigger is watched by ios.yml.
const IOS_UI_HELPER = "scripts/ci/ios-ui-smoke.py";
const IOS_UI_HELPER_TEST = "scripts/test/ios-ui-smoke-test.py";
const IOS_UI_HELPER_ARGS = '-- "${common[@]}" -- "${test_limits[@]}" -- "${selection[@]}" <<\'SELECT\'';

function iosCompactOverlapFailures(world) {
  const out = [];
  const need = (ok, message) => { if (!ok) out.push(message); };
  const doc = world.docs.get(IOS);
  const job = doc?.jobs?.[IOS_COMPACT_JOB];
  if (!job) return out;
  const where = `${IOS}/${IOS_COMPACT_JOB}`;
  const steps = job.steps ?? [];
  need(!steps.some((s) => s?.id === "iphone_sim" || s?.name === "Boot the selected iPhone simulator"),
    `${where}: a separate iPhone preparation step is back. Selection, boot and build run in ONE supervised stage; `
    + `a separate step would hand a device on through outputs and pay its own budget out of the test's.`);
  const at = steps.findIndex((s) => s?.id === "ui_smoke");
  const step = steps[at];
  need(step !== undefined, `${where}: no step has \`id: ui_smoke\`.`);
  if (!step) return out;
  need(step.name === "Run iOS primary-task UI smoke",
    `${where}: the \`ui_smoke\` step is named ${JSON.stringify(step.name)}; the toolchain registry locates the pinned `
    + `iPhone selection program by the name "Run iOS primary-task UI smoke".`);
  need(step.if === undefined,
    `${where}: the \`ui_smoke\` step's condition is ${JSON.stringify(step.if)}, want none on the full path (only the evidence guard).`);
  need(step["continue-on-error"] === undefined, `${where}: the \`ui_smoke\` step sets \`continue-on-error\`, so a failed boot, build or test no longer fails the job.`);
  need(Number(step["timeout-minutes"]) === 53,
    `${where}: the \`ui_smoke\` step's timeout-minutes is ${JSON.stringify(step["timeout-minutes"])}, want 53 — the original 5 + 48 `
    + `minutes, which the helper's 3170 s stage plus its 10 s cleanup reserve fits inside.`);
  need(JSON.stringify(Object.keys(step.env ?? {})) === JSON.stringify(["UI_SHARD"]),
    `${where}: the \`ui_smoke\` step's env is ${JSON.stringify(step.env)}, want only UI_SHARD (no device is handed in).`);
  const run = String(step.run ?? "");
  const code = run.split("\n").filter((l) => !/^\s*#/.test(l)).join("\n");
  need(code.split(`/usr/bin/python3 ${IOS_UI_HELPER} --shard "$UI_SHARD"`).length === 2 && code.includes(IOS_UI_HELPER_ARGS),
    `${where}: the \`ui_smoke\` step does not run \`/usr/bin/python3 ${IOS_UI_HELPER}\` exactly once with its own arrays and `
    + `the selection heredoc (\`${IOS_UI_HELPER_ARGS}\`).`);
  need(!/GITHUB_OUTPUT/.test(code), `${where}: the \`ui_smoke\` step writes GITHUB_OUTPUT; nothing is handed on from this stage.`);
  need(!/^\s*xcodebuild\b/m.test(code) && !/simctl\s+bootstatus/.test(code) && !/simctl\s+boot\b/.test(code) && !/\bsleep\b/.test(code),
    `${where}: the \`ui_smoke\` step runs xcodebuild, boots or sleeps itself; only the supervisor may, under its budgets.`);
  need(code.includes("xcrun simctl list devices available -j") && code.includes('startswith("iPhone")'),
    `${where}: the \`ui_smoke\` step no longer carries the job's own iPhone selection script.`);
  const xcodeAt = steps.findIndex((s) => SELECT_REF_RE.test(String(s?.run ?? "")));
  need(xcodeAt !== -1 && xcodeAt < at, `${where}: the Xcode selection does not run before the \`ui_smoke\` stage.`);
  const jobMinutes = Number(job["timeout-minutes"]);
  const bounded = steps.slice(0, at + 1).reduce((sum, s) => sum + (Number(s?.["timeout-minutes"]) || 0), 0);
  need(Number.isFinite(jobMinutes) && jobMinutes >= bounded,
    `${where}: the job's timeout-minutes ${JSON.stringify(job["timeout-minutes"])} is below the ${bounded} minutes its steps up to `
    + `\`ui_smoke\` may take in order.`);
  need(world.texts?.get?.(IOS) === undefined || String(world.texts.get(IOS)).includes(`- '${IOS_UI_HELPER}'`),
    `${IOS}: \`push.paths\` does not watch ${IOS_UI_HELPER}, so a change to the stage's supervisor would not start this lane.`);
  const hygiene = world.docs.get("repo-hygiene.yml");
  need(hygiene === undefined || JSON.stringify(hygiene).includes(`python3 ${IOS_UI_HELPER_TEST}`),
    `repo-hygiene.yml does not run ${IOS_UI_HELPER_TEST}, so the supervisor's process and budget controls never run in CI.`);
  return out;
}

/** Run the iPhone `ui_smoke` step as written (and the real helper) against stub xcrun/xcodebuild. */
function iosCompactOverlapExecutionFailures(world) {
  const out = [];
  const need = (ok, message) => { if (!ok) out.push(message); };
  const step = world.docs.get(IOS)?.jobs?.[IOS_COMPACT_JOB]?.steps?.find((s) => s?.id === "ui_smoke");
  const where = `${IOS}/${IOS_COMPACT_JOB}`;
  if (typeof step?.run !== "string") return [`${where}: no \`ui_smoke\` run script to execute.`];
  const dir = spawnSync("mktemp", ["-d", `${process.env.TMPDIR ?? "/tmp"}/ios-overlap.XXXXXX`], { encoding: "utf8" }).stdout.trim();
  if (!dir) return ["6v-iPhone: could not create a scratch directory."];
  try {
    const stub = (tool) => [
      "#!/bin/bash",
      'action="${@: -1}"; [ "$1 $2" = "simctl list" ] && action=list; [ "$1 $2" = "simctl bootstatus" ] && action=boot',
      `echo "start ${tool} $action $*" >> "$TOOL_CALLS"`,
      'if [ "$action" = list ]; then cat "$BOOT_LISTING_FILE"; echo "end list" >> "$TOOL_CALLS"; exit 0; fi',
      'if [ "$action" = boot ] && [ "$BOOT_MODE" = fail ]; then echo "end boot failed" >> "$TOOL_CALLS"; exit 149; fi',
      'if [ "$action" = build-for-testing ] && [ "$BUILD_MODE" = fail ]; then echo "end build-for-testing failed" >> "$TOOL_CALLS"; exit 65; fi',
      'case "$action" in boot) sleep 0.4 ;; build-for-testing) sleep 0.2 ;; esac',
      'case "$action" in boot|build-for-testing|test-without-building) echo "end $action" >> "$TOOL_CALLS"; exit 0 ;; esac',
      'echo "unexpected call: $*" >&2; exit 2', "",
    ].join("\n");
    spawnSync("bash", ["-c", 'mkdir -p "$1/bin" && printf "%s" "$2" > "$1/bin/xcrun" && printf "%s" "$3" > "$1/bin/xcodebuild" '
      + '&& chmod +x "$1/bin/xcrun" "$1/bin/xcodebuild"', "_", dir, stub("xcrun"), stub("xcodebuild")]);
    let n = 0;
    const run = ({ listing = BOOT_LISTING, shard = "complement", env = {} } = {}) => {
      n += 1;
      const rt = `${dir}/rt-${n}`;
      const calls = `${dir}/calls-${n}`;
      const output = `${dir}/output-${n}`;
      spawnSync("bash", ["-c", `mkdir -p "${rt}" && printf '%s' "$1" > "${dir}/listing-${n}.json" && printf '%s' "$2" > "${dir}/step-${n}.sh" && : > "${calls}" && : > "${output}"`,
        "_", JSON.stringify(listing), step.run]);
      const r = spawnSync("bash", ["-e", `${dir}/step-${n}.sh`], {
        encoding: "utf8", timeout: 30000, killSignal: "SIGKILL",
        env: { PATH: `${dir}/bin:/usr/bin:/bin`, TOOL_CALLS: calls, BOOT_LISTING_FILE: `${dir}/listing-${n}.json`,
          GITHUB_OUTPUT: output, RUNNER_TEMP: rt, UI_SHARD: shard, HOME: process.env.HOME ?? "", ...env },
      });
      const read = (f) => spawnSync("cat", [f], { encoding: "utf8" }).stdout ?? "";
      return { status: r.status, log: `${r.stdout ?? ""}${r.stderr ?? ""}`, calls: read(calls).split("\n").filter(Boolean), output: read(output), rt };
    };
    const idx = (calls, prefix) => calls.findIndex((c) => c.startsWith(prefix));
    for (const [label, listing, picks] of BOOT_CASES) {
      const want = picks.iPhone;
      const r = run({ listing });
      const starts = r.calls.filter((c) => c.startsWith("start ") && !c.startsWith("start xcrun list"));
      if (want === null) {
        need(r.status !== 0 && starts.length === 0 && r.output === "",
          `${where} (${label}): with no available iPhone the \`ui_smoke\` step must fail before any boot or build; got exit `
          + `${r.status}, calls [${starts.join(" | ")}].`);
        continue;
      }
      const udid = bootUdid(want[0]);
      const boots = r.calls.filter((c) => c.startsWith("start xcrun boot"));
      const builds = r.calls.filter((c) => c.startsWith("start xcodebuild build-for-testing"));
      const tests = r.calls.filter((c) => c.startsWith("start xcodebuild test-without-building"));
      need(r.status === 0, `${where} (${label}): the \`ui_smoke\` step failed on a listing with an available iPhone; exit ${r.status}.\n${r.log.slice(-1500)}`);
      need(boots.length === 1 && boots[0] === `start xcrun boot simctl bootstatus ${udid} -b`,
        `${where} (${label}): the stage ran boot barriers [${boots.join(" | ")}]; want exactly \`simctl bootstatus ${udid} -b\` (${want[1]}).`);
      need(builds.length === 1 && builds[0].includes(`-destination platform=iOS Simulator,id=${udid} `)
        && builds[0].includes(`-resultBundlePath ${r.rt}/ios-ui-build-complement.xcresult build-for-testing`),
      `${where} (${label}): the stage ran builds [${builds.join(" | ")}]; want one build-for-testing of ${udid} into its own bundle.`);
      need(tests.length === 1 && tests[0].includes(`-destination platform=iOS Simulator,id=${udid} `)
        && tests[0].includes(`-resultBundlePath ${r.rt}/ios-ui-smoke-complement.xcresult `)
        && tests[0].endsWith("-skip-testing:RelayiumUITests/AppShellUITests -only-testing:RelayiumUITests test-without-building"),
      `${where} (${label}): the stage ran tests [${tests.join(" | ")}]; want one test-without-building of ${udid} with the complement selection.`);
      const testAt = idx(r.calls, "start xcodebuild test-without-building");
      need(idx(r.calls, "start xcodebuild build-for-testing") < idx(r.calls, "end boot") && testAt > idx(r.calls, "end boot")
        && testAt > idx(r.calls, "end build-for-testing"),
      `${where} (${label}): the build did not overlap the boot, or the test started before both ended: [${r.calls.join(" | ")}].`);
      need(r.output === "", `${where} (${label}): the stage wrote ${JSON.stringify(r.output)} to GITHUB_OUTPUT.`);
    }
    const shell = run({ shard: "app-shell" });
    need(shell.status === 0 && shell.calls.some((c) => c.startsWith("start xcodebuild test-without-building")
      && c.endsWith("-collect-test-diagnostics never -only-testing:RelayiumUITests/AppShellUITests test-without-building")),
    `${where}: the app-shell shard did not test exactly AppShellUITests with diagnostics never.`);
    for (const [label, env] of [["a failed boot", { BOOT_MODE: "fail" }], ["a failed build", { BUILD_MODE: "fail" }]]) {
      const r = run({ env });
      need(r.status !== 0 && !r.calls.some((c) => c.startsWith("start xcodebuild test-without-building")),
        `${where}: after ${label} the stage must fail without testing; got exit ${r.status}, calls [${r.calls.join(" | ")}].`);
    }
    const unknown = run({ shard: "retired" });
    need(unknown.status !== 0 && unknown.calls.length === 0, `${where}: an unknown shard ran something or passed (exit ${unknown.status}).`);
  } finally {
    spawnSync("rm", ["-rf", dir]);
  }
  return out;
}

for (const message of iosCompactOverlapFailures(realWorld())) failures.push(message);
for (const message of iosCompactOverlapExecutionFailures(realWorld())) failures.push(message);

const IPHONE_OVERLAP_MUTATIONS = [
  {
    name: "the iPhone stage runs a helper that does not exist",
    mutate: (w) => withBootStepRun(w, IOS_COMPACT_JOB, "ui_smoke", (r) => r.replace(IOS_UI_HELPER, "scripts/ci/missing.py")),
    expect: /ios-ui-smoke \(listing\): the `ui_smoke` step failed on a listing with an available iPhone/,
  },
  {
    name: "the iPhone selection falls back to an iPad",
    mutate: (w) => withBootStepRun(w, IOS_COMPACT_JOB, "ui_smoke", (r) => r.replace('.startswith("iPhone")))', '.startswith(("iPhone", "iPad"))))')),
    expect: /ios-ui-smoke \(no iPhone available\): with no available iPhone the `ui_smoke` step must fail before any boot or build/,
  },
  {
    name: "the iPhone stage hands the device on through GITHUB_OUTPUT",
    mutate: (w) => withBootStepRun(w, IOS_COMPACT_JOB, "ui_smoke", (r) => r.replace('\necho "$device_id"\n', '\necho "device_id=$device_id" >> "$GITHUB_OUTPUT"\necho "$device_id"\n')),
    expect: /ios-ui-smoke: the `ui_smoke` step writes GITHUB_OUTPUT/,
  },
  {
    name: "the iPhone stage drops its own selection array",
    mutate: (w) => withBootStepRun(w, IOS_COMPACT_JOB, "ui_smoke", (r) => r.replace('-- "${selection[@]}"', "-- -only-testing:RelayiumUITests")),
    expect: /ios-ui-smoke: the `ui_smoke` step does not run `\/usr\/bin\/python3 scripts\/ci\/ios-ui-smoke\.py` exactly once with its own arrays/,
  },
  {
    name: "the iPhone stage runs whatever happened before",
    mutate: (w) => withBootStep(w, IOS_COMPACT_JOB, "ui_smoke", (s) => { s.if = "always()"; }),
    expect: /ios-ui-smoke: the `ui_smoke` step's condition is "always\(\)", want none on the full path/,
  },
  {
    name: "the iPhone stage continues on error",
    mutate: (w) => withBootStep(w, IOS_COMPACT_JOB, "ui_smoke", (s) => { s["continue-on-error"] = "true"; }),
    expect: /ios-ui-smoke: the `ui_smoke` step sets `continue-on-error`/,
  },
  {
    name: "the iPhone stage bound is raised",
    mutate: (w) => withBootStep(w, IOS_COMPACT_JOB, "ui_smoke", (s) => { s["timeout-minutes"] = "54"; }),
    expect: /ios-ui-smoke: the `ui_smoke` step's timeout-minutes is "54", want 53/,
  },
  {
    name: "the iPhone job bound no longer covers its step bounds",
    mutate: (w) => withNamedJob(w, IOS, IOS_COMPACT_JOB, (job) => { job["timeout-minutes"] = "60"; }),
    expect: /ios-ui-smoke: the job's timeout-minutes "60" is below the 63 minutes/,
  },
  {
    name: "the iPhone stage gets a device handed in again",
    mutate: (w) => withBootStep(w, IOS_COMPACT_JOB, "ui_smoke", (s) => { s.env = { ...s.env, DEVICE_ID: "${{ steps.iphone_sim.outputs.device_id }}" }; }),
    expect: /ios-ui-smoke: the `ui_smoke` step's env is .*want only UI_SHARD/,
  },
  {
    name: "the iPhone stage boots by itself",
    mutate: (w) => withBootStepRun(w, IOS_COMPACT_JOB, "ui_smoke", (r) => r.replace("\nesac\n", '\nesac\nxcrun simctl bootstatus booted -b\n')),
    expect: /ios-ui-smoke: the `ui_smoke` step runs xcodebuild, boots or sleeps itself/,
  },
];

for (const { name, mutate, expect } of IPHONE_OVERLAP_MUTATIONS) {
  let got;
  try {
    const world = mutate(realWorld());
    got = [...iosCompactOverlapFailures(world), ...iosCompactOverlapExecutionFailures(world)];
  } catch (err) {
    check(false, `the iPhone stage mutation "${name}" threw instead of reporting: ${err.message}`);
    continue;
  }
  check(got.some((message) => expect.test(message)),
    `the iPhone stage check did NOT complain about "${name}". Expected a message matching ${expect}; got `
    + `${got.length === 0 ? "no failures at all" : `[\n    ${got.join("\n    ")}\n  ]`}.`);
}

// ── 6r. every path-filtered reusable lane on disk is registered ─────────────
//
// A workflow that declares BOTH a `push.paths` filter and `workflow_call:` is,
// by shape, a conditional lane: something is meant to call it on a pull
// request and select it by that filter. If it is in neither `GOVERNED` nor the
// selector's `LANES`, then none of the trigger, concurrency or budget rules in
// this file bind it, the gate never calls it, and it runs only on `push: main`
// — after the merge it was supposed to gate. Before this rule such a lane was
// caught only if it happened to run `swift test` (the Swift boundary's host
// set); any other unregistered lane passed every CI guard. Read from disk, so a
// new file cannot route around it by existing.

function unregisteredLaneFailures(texts, governed, selectorLanes) {
  const out = [];
  const governedFiles = new Set(governed.map((g) => g.file));
  const laneFiles = new Set(selectorLanes.map((lane) => lane.workflow));
  const detected = new Set();
  for (const [name, text] of [...texts].sort(([a], [b]) => a.localeCompare(b))) {
    const filtered = /^ {2}push:[^\n]*\n(?:(?: {4,}[^\n]*| *)\n)*? {4}paths:/m.test(text);
    const callable = /^ {2}workflow_call:/m.test(text);
    if (!filtered || !callable) continue;
    detected.add(name);
    if (!governedFiles.has(name) || !laneFiles.has(name)) {
      out.push(`${name} declares a \`push.paths\` filter and \`workflow_call:\` — the shape of a `
        + `conditional lane — but is ${governedFiles.has(name) ? "" : "not in this file's GOVERNED "
        + "list"}${!governedFiles.has(name) && !laneFiles.has(name) ? " and " : ""}`
        + `${laneFiles.has(name) ? "" : `not in ${SELECTOR}'s LANES`}. Unregistered, no trigger, `
        + `concurrency or budget rule binds it and ${AGGREGATE} never calls it, so it runs only `
        + `after the merge it was meant to gate.`);
    }
  }
  // Non-vacuity: every lane the selector names must be recognised by the shape
  // test above, or the shape test has stopped matching real lanes and this
  // rule is passing by inspecting nothing.
  const missed = [...laneFiles].filter((file) => texts.has(file) && !detected.has(file)).sort();
  if (missed.length) {
    out.push(`6r's lane-shape test does not recognise [${missed.join(", ")}], which ${SELECTOR} `
      + `names as lanes. The closed-set rule would then pass on any lane shaped like them.`);
  }
  return out;
}

for (const message of unregisteredLaneFailures(workflowTexts, GOVERNED, SELECTOR_LANES)) {
  check(false, message);
}
{
  // The proof it can fail, and that it does not fire on the lanes that exist.
  const fake = "on:\n  push:\n    branches:\n      - main\n    paths:\n      - 'server/**'\n"
    + "  workflow_call:\njobs:\n  x:\n    runs-on: ubuntu-latest\n";
  const withFake = new Map([...workflowTexts, ["unregistered-lane.yml", fake]]);
  const got = unregisteredLaneFailures(withFake, GOVERNED, SELECTOR_LANES);
  check(
    got.length === 1 && /unregistered-lane\.yml declares a `push\.paths` filter and `workflow_call:`/.test(got[0]),
    `6r did NOT complain about an unregistered path-filtered reusable lane; got `
    + `${JSON.stringify(got)}. A closed-set rule that cannot fail is the hole it was written to close.`,
  );
  const selectorOnly = unregisteredLaneFailures(
    withFake, GOVERNED, [...SELECTOR_LANES, { id: "x", workflow: "unregistered-lane.yml" }],
  );
  check(
    selectorOnly.length === 1 && /not in this file's GOVERNED list/.test(selectorOnly[0]),
    `6r did NOT complain about a lane the selector calls but GOVERNED omits; got `
    + `${JSON.stringify(selectorOnly)}.`,
  );
}

// ── 6v. the full-bootstrap dispatch, EXECUTED against real git and a fake API ─
//
// `full-bootstrap` validates protected `main` itself with every lane and mints
// no proof. Its two judgements — the select step at the START and the aggregate
// at the END — are shell over the branches and compare APIs, so nothing here is
// read from the text: both scripts are taken out of the parsed workflow, their
// `env:` is evaluated from a modelled run context (an expression this file does
// not model is a failure, not a guess), and they are RUN with bash against a
// real git repository and a fake `gh` that records every argv and answers the
// compare API from that repository's own history, in GitHub's direction:
// `compare/BASE...HEAD` is `behind` with ahead_by 0 when HEAD is an ancestor.
//
// History: R <- X <- Y (main moved on past X) and R <- Z (main rewritten).
// The run's commit is X throughout. Attempt 1 needs main == X; a rerun
// (attempt >= 2) may find main at Y and prove X its ancestor; Z never passes.
// The END is the same on every attempt and is GREEN with a notice when main
// moved on past X, because a red merge-gate on a main commit would refuse every
// later promotion whose range holds it.
const BOOT_SELECT_STEP = "Collect the pull request's cumulative file list";
const BOOT_JUDGE_STEP = "Judge every lane";
const BOOT_REPO = "relayium/relayium";

/** The fixture: real commits, a checkout at X and one at Y, and the fake gh. */
function bootstrapFixture() {
  const root = spawnSync("mktemp", ["-d", `${process.env.TMPDIR ?? "/tmp"}/full-bootstrap.XXXXXX`], { encoding: "utf8" })
    .stdout.trim();
  const git = (args, cwd = `${root}/repo`) => {
    const r = spawnSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid", GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@example.invalid", GIT_AUTHOR_DATE: "2026-10-02T00:00:00Z", GIT_COMMITTER_DATE: "2026-10-02T00:00:00Z" } });
    if (r.status !== 0) throw new Error(`fixture git ${args.join(" ")}: ${r.stderr}`);
    return r.stdout.trim();
  };
  spawnSync("mkdir", ["-p", `${root}/repo`, `${root}/bin`]);
  git(["init", "-q", "-b", "main"]);
  const commit = (msg) => { git(["commit", "-q", "--allow-empty", "-m", msg]); return git(["rev-parse", "HEAD"]); };
  const R = commit("R");
  const X = commit("X");
  const Y = commit("Y");
  git(["checkout", "-q", "--detach", R]);
  const Z = commit("Z");
  git(["checkout", "-q", "--detach", X]);
  git(["worktree", "add", "-q", "--detach", `${root}/at-y`, Y]);
  const fakeGh = [
    "#!/usr/bin/env node",
    'const { appendFileSync } = require("node:fs");',
    'const { spawnSync } = require("node:child_process");',
    "const argv = process.argv.slice(2);",
    "appendFileSync(process.env.FAKE_GH_LOG, JSON.stringify(argv) + '\\n');",
    "const plan = JSON.parse(process.env.FAKE_GH_PLAN);",
    "if (process.env.GH_TOKEN !== 'test-token') { console.error('no token'); process.exit(4); }",
    "if (argv.length !== 2 || argv[0] !== 'api') { console.error('unexpected argv'); process.exit(2); }",
    "const path = argv[1];",
    "if (path === `repos/${plan.repo}/branches/main`) {",
    "  if (plan.branch === 'fail') { console.error('HTTP 502'); process.exit(1); }",
    "  process.stdout.write(JSON.stringify(plan.branch)); process.exit(0);",
    "}",
    "const m = /^repos\\/([^/]+\\/[^/]+)\\/compare\\/([0-9a-f]{40})\\.\\.\\.([0-9a-f]{40})$/.exec(path);",
    "if (!m || m[1] !== plan.repo) { console.error('HTTP 404 ' + path); process.exit(1); }",
    "if (plan.compare === 'fail') { console.error('HTTP 500'); process.exit(1); }",
    "if (plan.compare && typeof plan.compare === 'object') { process.stdout.write(JSON.stringify(plan.compare)); process.exit(0); }",
    "const g = (...a) => spawnSync('git', a, { cwd: plan.gitDir, encoding: 'utf8' }).stdout.trim();",
    "const [, , base, head] = m;",
    "const ahead = Number(g('rev-list', '--count', `${base}..${head}`));",
    "const behind = Number(g('rev-list', '--count', `${head}..${base}`));",
    "const mb = g('merge-base', base, head);",
    "const status = ahead === 0 && behind === 0 ? 'identical' : ahead === 0 ? 'behind' : behind === 0 ? 'ahead' : 'diverged';",
    "process.stdout.write(JSON.stringify({ status, ahead_by: ahead, behind_by: behind, base_commit: { sha: base },",
    "  merge_base_commit: { sha: mb }, commits: [] }));",
  ].join("\n");
  spawnSync("bash", ["-c", 'printf "%s\\n" "$2" > "$1/gh" && chmod +x "$1/gh"', "_", `${root}/bin`, fakeGh]);
  return { root, R, X, Y, Z, atX: `${root}/repo`, atY: `${root}/at-y`, gitDir: `${root}/repo` };
}

/** Evaluate one `env:` value of the two steps from a modelled context; throws on anything else. */
function bootstrapEnvValue(raw, ctx) {
  const v = String(raw);
  const m = /^\$\{\{ (.+) \}\}$/.exec(v);
  if (!m) return v;
  const table = {
    "secrets.GITHUB_TOKEN": "test-token",
    "github.token": "test-token",
    "github.repository": ctx.repository,
    "github.sha": ctx.sha,
    "github.run_attempt": ctx.runAttempt,
    "github.event_name == 'workflow_dispatch'": String(ctx.event === "workflow_dispatch"),
    "github.event.pull_request.number || inputs.pr_number": ctx.inputs.pr_number,
    "inputs.mode": ctx.inputs.mode,
    "inputs.pr_number": ctx.inputs.pr_number,
    "inputs.base_sha": ctx.inputs.base_sha,
    "inputs.head_sha": ctx.inputs.head_sha,
    "toJSON(needs)": JSON.stringify(ctx.needs),
    "toJSON(needs.select.outputs)": JSON.stringify(ctx.selected),
  };
  if (!(m[1] in table)) throw new Error(`unmodelled env expression ${v}`);
  return table[m[1]];
}

/** Run one of the two steps for one case; returns { status, stdout, stderr, output, summary, calls }. */
function runBootstrapStep(world, fx, which, ctx, plan, cwd) {
  const gate = world.docs.get(AGGREGATE);
  const job = gate?.jobs?.[which === "select" ? SELECT_JOB : GATE_JOB];
  const step = (job?.steps ?? []).find((s) => s?.name === (which === "select" ? BOOT_SELECT_STEP : BOOT_JUDGE_STEP));
  if (typeof step?.run !== "string") throw new Error(`${AGGREGATE}/${which}: no step with a run script`);
  // The only inline expression either script may carry is the pull request's
  // own changed_files, empty on a dispatch.
  const inline = step.run.match(/\$\{\{[^}]*\}\}/g) ?? [];
  const allowed = which === "select" ? ["${{ github.event.pull_request.changed_files }}"] : [];
  if (JSON.stringify(inline) !== JSON.stringify(allowed)) throw new Error(`${AGGREGATE}/${which}: inline expressions ${JSON.stringify(inline)}`);
  const script = step.run.replace("${{ github.event.pull_request.changed_files }}", "");
  const dir = spawnSync("mktemp", ["-d", `${fx.root}/run.XXXXXX`], { encoding: "utf8" }).stdout.trim();
  const env = { PATH: `${fx.root}/bin:${process.env.PATH}`, HOME: process.env.HOME ?? "/tmp", GITHUB_REF: ctx.ref,
    RUNNER_TEMP: dir, GITHUB_OUTPUT: `${dir}/output`, GITHUB_STEP_SUMMARY: `${dir}/summary`, FAKE_GH_LOG: `${dir}/gh.log`,
    FAKE_GH_PLAN: JSON.stringify({ repo: BOOT_REPO, gitDir: fx.gitDir, ...plan }) };
  for (const [k, raw] of Object.entries(step.env ?? {})) env[k] = bootstrapEnvValue(raw, ctx);
  spawnSync("bash", ["-c", 'printf "%s" "$2" > "$1/step.sh" && : > "$1/output" && : > "$1/gh.log"', "_", dir, script]);
  const r = spawnSync("bash", [`${dir}/step.sh`], { cwd, env, encoding: "utf8" });
  const read = (f) => spawnSync("cat", [`${dir}/${f}`], { encoding: "utf8" }).stdout;
  const calls = read("gh.log").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, output: read("output"), summary: read("summary"), calls };
}

/** Every full-bootstrap case, GREEN and RED, against one (possibly mutated) world. */
function fullBootstrapFailures(world, fx, only = null) {
  const out = [];
  const need = (ok, message) => { if (!ok) out.push(message); };
  const { X, Y, Z } = fx;
  const lanes = [...GATE_LANES.keys()];
  const base = { event: "workflow_dispatch", ref: "refs/heads/main", sha: X, runAttempt: "1", repository: BOOT_REPO,
    inputs: { mode: "full-bootstrap", pr_number: "", base_sha: X, head_sha: X } };
  const protectedAt = (sha) => ({ name: "main", protected: true, commit: { sha } });
  const branchCall = ["api", `repos/${BOOT_REPO}/branches/main`];
  const compareCall = (cur) => ["api", `repos/${BOOT_REPO}/compare/${cur}...${X}`];
  const merge = (patch) => ({ ...base, ...patch, inputs: { ...base.inputs, ...(patch.inputs ?? {}) } });

  // ── START: the select step ──
  const select = (label, patch, plan, expect, cwd = fx.atX) => {
    if (only && !only(`select, ${label}`)) return;
    let r;
    try { r = runBootstrapStep(world, fx, "select", merge(patch), plan, cwd); } catch (err) { need(false, `full bootstrap select, ${label}: ${err.message}`); return; }
    if (expect.ok) {
      need(r.status === 0 && r.output === "status=full-bootstrap\npayload=\nchanged_files=\n",
        `full bootstrap select, ${label}: want exit 0 and status=full-bootstrap; got exit ${r.status}, output ${JSON.stringify(r.output)}, stderr ${r.stdout.slice(-300)}${r.stderr.slice(-300)}`);
    } else {
      need(r.status === 1 && r.output === "" && expect.reason.test(r.stdout),
        `full bootstrap select, ${label}: want exit 1 for ${expect.reason} with no output; got exit ${r.status}, output ${JSON.stringify(r.output)}, ${r.stdout.slice(-300)}`);
    }
    if (expect.calls) {
      need(JSON.stringify(r.calls) === JSON.stringify(expect.calls),
        `full bootstrap select, ${label}: want API calls ${JSON.stringify(expect.calls)}; got ${JSON.stringify(r.calls)}`);
    }
    return r;
  };
  const green = select("attempt 1 on current protected main", {}, { branch: protectedAt(X) }, { ok: true, calls: [branchCall] });
  if (green?.status === 0) {
    // ...and the selector turns that status into every lane.
    const sel = spawnSync(process.execPath, [resolve(repoRoot, "scripts/ci/select-lanes.mjs")], { encoding: "utf8",
      env: { PATH: process.env.PATH, LANE_SELECTOR_STATUS: "full-bootstrap", LANE_SELECTOR_FILES: "", LANE_SELECTOR_CHANGED_FILES: "" } });
    need(sel.status === 0 && sel.stdout === `${lanes.map((l) => `${l}=true`).join("\n")}\n`,
      `full bootstrap select: the selector did not turn status=full-bootstrap into every lane: ${sel.stdout}${sel.stderr}`);
  }
  select("attempt 2 on current protected main", { runAttempt: "2" }, { branch: protectedAt(X) }, { ok: true, calls: [branchCall] });
  select("attempt 2 with main moved on past X", { runAttempt: "2" }, { branch: protectedAt(Y) }, { ok: true, calls: [branchCall, compareCall(Y)] });
  select("attempt 7 with main moved on past X", { runAttempt: "7" }, { branch: protectedAt(Y) }, { ok: true, calls: [branchCall, compareCall(Y)] });
  const no = (reason, calls) => ({ ok: false, reason, calls });
  select("attempt 1 with main moved on past X", {}, { branch: protectedAt(Y) }, no(/a first attempt validates current main only/, [branchCall]));
  select("attempt 2 with main rewritten (diverged)", { runAttempt: "2" }, { branch: protectedAt(Z) }, no(/is not a true ancestor/, [branchCall, compareCall(Z)]));
  select("attempt 2 when the compare API fails", { runAttempt: "2" }, { branch: protectedAt(Y), compare: "fail" }, no(/compare API did not answer/));
  for (const [what, compare] of [
    ["status ahead", { status: "ahead", ahead_by: 0, behind_by: 1, base_commit: { sha: Y }, merge_base_commit: { sha: X } }],
    ["ahead_by a string", { status: "behind", ahead_by: "0", behind_by: 1, base_commit: { sha: Y }, merge_base_commit: { sha: X } }],
    ["behind_by 0", { status: "behind", ahead_by: 0, behind_by: 0, base_commit: { sha: Y }, merge_base_commit: { sha: X } }],
    ["fractional behind_by 1.5", { status: "behind", ahead_by: 0, behind_by: 1.5, base_commit: { sha: Y }, merge_base_commit: { sha: X } }],
    ["another base", { status: "behind", ahead_by: 0, behind_by: 1, base_commit: { sha: Z }, merge_base_commit: { sha: X } }],
    ["another merge base", { status: "behind", ahead_by: 0, behind_by: 1, base_commit: { sha: Y }, merge_base_commit: { sha: fx.R } }],
    ["no merge base", { status: "behind", ahead_by: 0, behind_by: 1, base_commit: { sha: Y } }],
  ]) {
    select(`attempt 2 with a compare answer of ${what}`, { runAttempt: "2" }, { branch: protectedAt(Y), compare }, no(/is not a true ancestor/, [branchCall, compareCall(Y)]));
  }
  select("a ref other than main", { ref: "refs/heads/internal-candidate/x" }, { branch: protectedAt(X) }, no(/refs\/heads\/main only/, []));
  select("a pull_request ref", { ref: "refs/pull/7/merge" }, { branch: protectedAt(X) }, no(/refs\/heads\/main only/, []));
  select("a short head_sha", { inputs: { head_sha: X.slice(0, 12), base_sha: X.slice(0, 12) } }, { branch: protectedAt(X) }, no(/full lowercase SHAs/, []));
  select("an uppercase SHA", { inputs: { head_sha: X.toUpperCase(), base_sha: X.toUpperCase() } }, { branch: protectedAt(X) }, no(/full lowercase SHAs/, []));
  select("base_sha unequal to head_sha", { inputs: { base_sha: fx.R } }, { branch: protectedAt(X) }, no(/base_sha == head_sha == the run's commit/, []));
  select("inputs naming another commit than the run's", { inputs: { base_sha: Y, head_sha: Y } }, { branch: protectedAt(Y) }, no(/base_sha == head_sha == the run's commit/, []));
  select("a pr_number", { inputs: { pr_number: "7" } }, { branch: protectedAt(X) }, no(/takes no pr_number/, []));
  for (const attempt of ["0", "", "x", "-1", "1 "]) {
    select(`run attempt ${JSON.stringify(attempt)}`, { runAttempt: attempt }, { branch: protectedAt(X) }, no(/not a positive integer/, []));
  }
  select("a checkout of another commit", {}, { branch: protectedAt(X) }, no(/the select checkout is/, []), fx.atY);
  select("a failing branches API", {}, { branch: "fail" }, no(/branches API did not answer/, [branchCall]));
  for (const [what, branch] of [
    ["unprotected", { name: "main", protected: false, commit: { sha: X } }],
    ["protected as a string", { name: "main", protected: "true", commit: { sha: X } }],
    ["no protected field", { name: "main", commit: { sha: X } }],
    ["another branch", { name: "dev", protected: true, commit: { sha: X } }],
    ["no commit", { name: "main", protected: true }],
    ["a short commit", { name: "main", protected: true, commit: { sha: X.slice(0, 7) } }],
    ["a shell payload as its commit", { name: "main", protected: true, commit: { sha: `$(touch ${fx.root}/pwned)` } }],
    ["a path payload as its commit", { name: "main", protected: true, commit: { sha: `${Y}/../../x` } }],
  ]) {
    // Attempt 2, so that a SHA the shape check missed would reach the compare API.
    select(`attempt 2 with main ${what}`, { runAttempt: "2" }, { branch }, no(/does not report main protected at a full SHA/, [branchCall]));
  }
  need(only || spawnSync("test", ["-e", `${fx.root}/pwned`]).status !== 0, "full bootstrap select: a branches API answer was EXECUTED by the shell.");

  // ── END: the aggregate ──
  const allNeeds = () => Object.fromEntries([[SELECT_JOB, { result: "success" }], ...lanes.map((l) => [l, { result: "success" }]),
    ...GATE_ALWAYS.map((l) => [l, { result: "success" }])]);
  const allSelected = () => Object.fromEntries(lanes.map((l) => [l, "true"]));
  const judge = (label, patch, plan, expect, mutate) => {
    if (only && !only(`aggregate, ${label}`)) return;
    const ctx = merge(patch);
    ctx.needs = allNeeds();
    ctx.selected = allSelected();
    if (mutate) mutate(ctx);
    let r;
    try { r = runBootstrapStep(world, fx, "judge", ctx, plan, fx.atX); } catch (err) { need(false, `full bootstrap aggregate, ${label}: ${err.message}`); return; }
    const text = `${r.stdout}${r.stderr}`;
    if (expect.ok) {
      need(r.status === 0 && expect.say.test(text), `full bootstrap aggregate, ${label}: want exit 0 saying ${expect.say}; got exit ${r.status}: ${text.slice(-500)}`);
    } else {
      need(r.status === 1 && expect.reason.test(r.stderr), `full bootstrap aggregate, ${label}: want exit 1 for ${expect.reason}; got exit ${r.status}: ${text.slice(-500)}`);
    }
    if (expect.calls) {
      need(JSON.stringify(r.calls) === JSON.stringify(expect.calls),
        `full bootstrap aggregate, ${label}: want API calls ${JSON.stringify(expect.calls)}; got ${JSON.stringify(r.calls)}`);
    }
    if (expect.summary) need(expect.summary.test(r.summary), `full bootstrap aggregate, ${label}: step summary ${JSON.stringify(r.summary)} does not match ${expect.summary}`);
    return r;
  };
  judge("main still at X", {}, { branch: protectedAt(X) }, { ok: true, say: new RegExp(`protected main is still ${X}`), calls: [branchCall] });
  const movedSay = new RegExp(`::notice::full bootstrap validated ${X}; protected main has since moved on to ${Y}, of which ${X} is an ancestor\\. This run does not validate ${Y}\\.`);
  for (const attempt of ["1", "3"]) {
    judge(`attempt ${attempt}, main moved on past X`, { runAttempt: attempt }, { branch: protectedAt(Y) },
      { ok: true, say: movedSay, calls: [branchCall, compareCall(Y)], summary: new RegExp(`validated ${X}; latest observed main ${Y} \\(not validated by this run\\)`) });
  }
  const bad = (reason, calls) => ({ ok: false, reason, calls });
  judge("main rewritten (diverged)", {}, { branch: protectedAt(Z) }, bad(/is not a true ancestor of current main/, [branchCall, compareCall(Z)]));
  judge("a failing branches API", {}, { branch: "fail" }, bad(/branches API did not answer for main at the end/, [branchCall]));
  judge("main unprotected", {}, { branch: { name: "main", protected: false, commit: { sha: X } } }, bad(/does not report main protected/, [branchCall]));
  judge("protected as a string", {}, { branch: { name: "main", protected: "true", commit: { sha: X } } }, bad(/does not report main protected/, [branchCall]));
  judge("a shell payload as main's commit", {}, { branch: { name: "main", protected: true, commit: { sha: `$(touch ${fx.root}/pwned-end)` } } },
    bad(/does not report main protected/, [branchCall]));
  judge("a failing compare API", {}, { branch: protectedAt(Y), compare: "fail" }, bad(/compare API did not answer/));
  judge("a compare answer of fractional behind_by 1.5", {}, { branch: protectedAt(Y), compare: { status: "behind", ahead_by: 0, behind_by: 1.5,
    base_commit: { sha: Y }, merge_base_commit: { sha: X } } }, bad(/is not a true ancestor of current main/, [branchCall, compareCall(Y)]));
  judge("a compare answer of status ahead", {}, { branch: protectedAt(Y), compare: { status: "ahead", ahead_by: 1, behind_by: 0,
    base_commit: { sha: Y }, merge_base_commit: { sha: Y } } }, bad(/is not a true ancestor/));
  judge("a ref other than main", { ref: "refs/heads/feature" }, { branch: protectedAt(X) }, bad(/want base == head == the run's commit on refs\/heads\/main/, []));
  judge("base_sha unequal to head_sha", { inputs: { base_sha: fx.R } }, { branch: protectedAt(X) }, bad(/want base == head/, []));
  judge("head_sha not the run's commit", { inputs: { head_sha: Y, base_sha: Y } }, { branch: protectedAt(X) }, bad(/want base == head/, []));
  judge("a pr_number", { inputs: { pr_number: "7" } }, { branch: protectedAt(X) }, bad(/no pr_number/, []));
  judge("a lane not selected (and so skipped)", {}, { branch: protectedAt(X) }, bad(/full bootstrap mode: windows was selected="false"; this mode runs every lane/),
    (ctx) => { ctx.selected.windows = "false"; ctx.needs.windows.result = "skipped"; });
  judge("a lane with no selection", {}, { branch: protectedAt(X) }, bad(/full bootstrap mode: macos was selected="missing"/),
    (ctx) => { delete ctx.selected.macos; });
  for (const result of ["failure", "cancelled", "skipped"]) {
    judge(`a called lane ${result}`, {}, { branch: protectedAt(X) }, bad(new RegExp(`ios: selected by this change set, but its result is "${result}"`)),
      (ctx) => { ctx.needs.ios.result = result; });
  }
  judge("an unconditional lane failed", {}, { branch: protectedAt(X) }, bad(/compat: result is "failure"/), (ctx) => { ctx.needs.compat.result = "failure"; });
  judge("select failed", {}, { branch: protectedAt(X) }, bad(/select: result is "failure"/), (ctx) => { ctx.needs.select.result = "failure"; });
  judge("a lane dropped from needs", {}, { branch: protectedAt(X) }, bad(/this job depends on/), (ctx) => { delete ctx.needs["swift-package"]; });
  judge("a fake lane added to needs", {}, { branch: protectedAt(X) }, bad(/this job depends on/), (ctx) => { ctx.needs.fake = { result: "success" }; });
  need(only || spawnSync("test", ["-e", `${fx.root}/pwned-end`]).status !== 0, "full bootstrap aggregate: a branches API answer was EXECUTED by the shell.");

  // The other modes never reach the API: a pull request run makes no call.
  judge("an ordinary pull request run", { event: "pull_request", ref: "refs/pull/7/merge", inputs: { mode: "", base_sha: "", head_sha: "" } },
    { branch: "fail" }, { ok: true, say: /every selected lane succeeded/, calls: [] });

  // The wiring the cases above stand on: the attempt is GitHub's own counter,
  // and the token, repository and identity come from the run, not a free input.
  const gate = world.docs.get(AGGREGATE);
  const selEnv = (gate?.jobs?.[SELECT_JOB]?.steps ?? []).find((s) => s?.name === BOOT_SELECT_STEP)?.env ?? {};
  const judgeEnv = (gate?.jobs?.[GATE_JOB]?.steps ?? []).find((s) => s?.name === BOOT_JUDGE_STEP)?.env ?? {};
  need(selEnv.RUN_ATTEMPT === "${{ github.run_attempt }}" && selEnv.CHECKED_SHA === "${{ github.sha }}"
    && selEnv.REPOSITORY === "${{ github.repository }}",
  `${AGGREGATE}/${SELECT_JOB}: RUN_ATTEMPT, CHECKED_SHA and REPOSITORY must come from github.run_attempt, github.sha and github.repository; got ${JSON.stringify(selEnv)}.`);
  need(judgeEnv.CHECKED_SHA === "${{ github.sha }}" && judgeEnv.REPOSITORY === "${{ github.repository }}"
    && judgeEnv.GH_TOKEN === "${{ github.token }}" && judgeEnv.EXPECTED_BASE === "${{ inputs.base_sha }}"
    && judgeEnv.PR_INPUT === "${{ inputs.pr_number }}",
  `${AGGREGATE}/${GATE_JOB}: the full-bootstrap END must read the run's own sha, repository and token and the dispatch inputs; got ${JSON.stringify(judgeEnv)}.`);
  return out;
}

{
  const fx = bootstrapFixture();
  const original = docs.get(AGGREGATE);
  const originalBytes = readFileSync(resolve(workflowsDir, AGGREGATE));
  const world = { docs: new Map([[AGGREGATE, original]]) };
  const got = fullBootstrapFailures(world, fx);
  for (const message of got) check(false, message);

  // The proof each rule can fail: one edit of the actual script per rule, in a
  // copy of the parsed workflow, each refused for its own reason.
  const stepOf = (w, which) => w.docs.get(AGGREGATE).jobs[which === "select" ? SELECT_JOB : GATE_JOB].steps
    .find((s) => s.name === (which === "select" ? BOOT_SELECT_STEP : BOOT_JUDGE_STEP));
  const edit = (which, from, to) => (w) => {
    const st = stepOf(w, which);
    if (!st.run.includes(from)) throw new Error(`control edit not found: ${from}`);
    st.run = st.run.split(from).join(to);
  };
  for (const [name, mutate, expect] of [
    ["the first attempt accepts an ancestor", edit("select", '[ "$RUN_ATTEMPT" != 1 ] ||', "true ||"),
      /select, attempt 1 with main moved on past X: want exit 1/],
    ["the compare direction is reversed", edit("select", '"repos/$REPOSITORY/compare/$current...$CHECKED_SHA"', '"repos/$REPOSITORY/compare/$CHECKED_SHA...$current"'),
      /select, attempt 2 with main moved on past X: want exit 0/],
    ["the start accepts an unprotected main", edit("select", "and (.protected == true)\n", "\n"),
      /select, attempt 2 with main unprotected: want exit 1/],
    ["the start forgets the shape of main's SHA", edit("select", '&& [[ "$current" =~ $hex40 ]] || {', '|| {'),
      /select, attempt 2 with main a short commit: want exit 1/],
    ["the start forgets its checkout", edit("select", '[ "$checkout" = "$CHECKED_SHA" ]', "true"),
      /select, a checkout of another commit: want exit 1/],
    ["the start accepts a pr_number", edit("select", '[ -z "$PR_NUMBER" ] ||', "true ||"),
      /select, a pr_number: want exit 1/],
    ["the start accepts another ref", edit("select", '[ "${GITHUB_REF:-}" = refs/heads/main ] ||', "true ||"),
      /select, a ref other than main: want exit 1/],
    ["the start accepts an ahead answer", edit("select", '(.status == "behind") and', '(.status == "behind" or .status == "ahead") and'),
      /select, attempt 2 with a compare answer of status ahead: want exit 1/],
    ["the end turns red when main moved on", edit("judge", 'echo "::notice::full bootstrap validated', 'note "moved"; echo "::notice::full bootstrap validated'),
      /aggregate, attempt 1, main moved on past X: want exit 0/],
    ["the end skips the ancestry predicate", edit("judge", `and (.merge_base_commit.sha == $x)' "$compare"`, `or true' "$compare"`),
      /aggregate, main rewritten \(diverged\): want exit 1/],
    ["the end forgets protection", edit("judge", "and (.protected == true)\n", "\n"),
      /aggregate, main unprotected: want exit 1/],
    ["the end forgets every lane is selected", edit("judge", 'note "full bootstrap mode: $lane was selected', 'true "full bootstrap mode: $lane was selected'),
      /aggregate, a lane not selected \(and so skipped\): want exit 1/],
    ["the end forgets base == head", edit("judge", '|| [ "$EXPECTED_BASE" != "$CHECKED_SHA" ] ', ""),
      /aggregate, base_sha unequal to head_sha: want exit 1/],
    // The integer half of `behind_by >= 1`, deleted from one branch at a time.
    ["the start accepts a fractional behind_by", edit("select", " and (.behind_by == (.behind_by | floor))", ""),
      /select, attempt 2 with a compare answer of fractional behind_by 1\.5: want exit 1/],
    ["the end accepts a fractional behind_by", edit("judge", " and (.behind_by == (.behind_by | floor))", ""),
      /aggregate, a compare answer of fractional behind_by 1\.5: want exit 1/],
    ["the attempt becomes a caller input", (w) => { stepOf(w, "select").env.RUN_ATTEMPT = "${{ inputs.pr_number }}"; },
      /RUN_ATTEMPT, CHECKED_SHA and REPOSITORY must come from github\.run_attempt/],
  ]) {
    const copy = { docs: new Map([[AGGREGATE, structuredClone(original)]]) };
    let failuresOf;
    try {
      mutate(copy);
      // Only the case the control's reason names (the wiring checks always run):
      // every case is already proven GREEN/RED on the unmutated workflow above.
      failuresOf = fullBootstrapFailures(copy, fx, (label) => expect.test(`full bootstrap ${label}: want exit 0`)
        || expect.test(`full bootstrap ${label}: want exit 1`));
    } catch (err) {
      failuresOf = null;
      check(false, `6v control "${name}" could not be applied: ${err.message}`);
    }
    if (failuresOf) {
      check(failuresOf.some((m) => expect.test(m)),
        `6v control "${name}" was NOT refused for its own reason ${expect}; got ${JSON.stringify(failuresOf.slice(0, 4))}. `
        + "A full-bootstrap rule nothing has seen fail is one the gate cannot rely on.");
    }
  }
  // And nothing above touched the workflow it judged.
  check(Buffer.compare(originalBytes, readFileSync(resolve(workflowsDir, AGGREGATE))) === 0
    && fullBootstrapFailures(world, fx).length === 0,
  `6v: ${AGGREGATE} changed on disk, or the unmutated cases stopped passing after the controls.`);
  spawnSync("rm", ["-rf", fx.root]);
}

// ── report ──────────────────────────────────────────────────────────────────

if (failures.length > 0) {
  console.error(`ci-event-policy-test: ${failures.length} failure(s)\n`);
  for (const message of failures) console.error(`  ✗ ${message}\n`);
  process.exit(1);
}
console.log(
  `ci-event-policy-test: OK (${GOVERNED.length} governed workflows + ${NIGHTLY} + ${FUZZ_NIGHTLY}`
  + `, runner budget on ${RUNNER_BUDGETS.map((b) => b.file).join(", ")}`
  + `, concurrency on ${CONCURRENCY_GOVERNED.length} files`
  + `, ${MACOS} read-only and ${MACOS_RELEASE} the sole release entry point`
  + `, ${AGGREGATE} calling ${GATE_LANES.size} conditional + ${GATE_ALWAYS.length} unconditional `
  + `lane(s) behind the job \`${GATE_JOB}\`)`,
);
