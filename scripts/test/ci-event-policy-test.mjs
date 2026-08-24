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
import { readFile } from "node:fs/promises";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { PATH_MATRIX } from "./fixtures/ci-path-selection.mjs";

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
  // The shared Swift package's own lane. It is here for the same reason every
  // other filtered workflow is — its triggers, its concurrency and its
  // push/pull_request path symmetry would otherwise be governed by nothing.
  // WHAT it owns (the repository's sole unfiltered `swift test`, the ordered
  // `!apps/RelayiumKit/Tests/**` exclusions, and which workflow starts on which
  // package path) belongs to `scripts/test/swift-ci-boundary-test.mjs`.
  { file: "swift-package.yml", dispatch: true, call: true, directPr: false },
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
  ["swift-package", "swift-package.yml"],
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
  ["swift-package.yml", "swift-package-lane"],
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

// ── 3. the account race lane is sharded, and the shards really run ──────────

const go = docs.get("go.yml");
if (go) {
  const shardJobs = Object.entries(go.jobs ?? {}).filter(
    ([, job]) => job?.strategy?.matrix?.shard !== undefined,
  );
  check(
    shardJobs.length === 1,
    `go.yml: expected exactly one job with a \`strategy.matrix.shard\`; found ${shardJobs.length}. `
    + `That matrix is the only thing splitting the ~43m35s account race lane into finite pieces.`,
  );

  if (shardJobs.length === 1) {
    const [name, job] = shardJobs[0];
    const shard = job.strategy.matrix.shard;
    check(
      Array.isArray(shard) && shard.length === SHARDS
        && shard.map(String).join(",") === Array.from({ length: SHARDS }, (_, k) => k).join(","),
      `go.yml/${name}: matrix.shard is ${JSON.stringify(shard)}, want 0..${SHARDS - 1}. `
      + `A missing index is a set of tests that silently stops being race-checked.`,
    );
    check(
      job.strategy["fail-fast"] === "false",
      `go.yml/${name}: strategy.fail-fast is ${JSON.stringify(job.strategy["fail-fast"])}, want false — `
      + `one shard reporting a race must not cancel the other seven and leave them unknown.`,
    );

    const text = runText(job);
    check(
      text.includes(SHARD_HELPER),
      `go.yml/${name}: no longer invokes ${SHARD_HELPER}, which is what proves the eight shards `
      + `partition the test list exactly.`,
    );
    check(
      /-shards\s+8/.test(text) && /-shard\s+'?\$\{\{\s*matrix\.shard/.test(text),
      `go.yml/${name}: does not pass \`-shards 8\` and the matrix index to ${SHARD_HELPER}, so `
      + `every shard would run the same tests.`,
    );
    check(
      /go test .*-race/.test(text) && /-run\s+"\$RUN_REGEX"/.test(text),
      `go.yml/${name}: does not run \`go test -race\` restricted to the shard's \`-run\` regex.`,
    );
    assertNoRetryAndFiniteTimeouts("go.yml", name, job, text);
  }

  // The other half of ./... — everything the shards do not cover.
  const restJobs = Object.entries(go.jobs ?? {}).filter(([jobName, job]) => {
    const text = runText(job);
    return jobName !== shardJobs[0]?.[0] && /go test .*-race/.test(text);
  });
  check(
    restJobs.length === 1,
    `go.yml: expected exactly one non-account race job; found ${restJobs.length}. Without it every `
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

// ── 6k's subjects, declared beside the workflows they are about ─────────────
//
// The SwiftPM package both native apps compile against, and the XCTest work in
// it that reads `apps/ios` — the project file, the privacy manifest, the
// distribution/signing configuration, the icon set, and the version the app
// shares with its share extension.
//
// They are named here, one at a time, for the same reason `GOVERNED` is: the
// list IS the assertion. A pattern would silently adopt or silently drop
// whatever matched it next, and the failure mode this section exists for is a
// gate that stopped covering something without anybody deciding to stop.
const SWIFT_PACKAGE_DIR = "apps/RelayiumKit";
const SWIFT_TEST_TARGET = "RelayiumKitTests";
const SWIFT_TEST_TARGET_DIR = `${SWIFT_PACKAGE_DIR}/Tests/${SWIFT_TEST_TARGET}`;

// Everything after `RelayiumKitTests.` in one `--filter`, in SwiftPM's own
// syntax: a bare class name selects the whole class, and `Class/method` selects
// exactly one case.
//
// Four are whole classes because every case in them reads `apps/ios`. The fifth
// is a single method because its class is not iOS-only:
// `BundleVersionTests` also carries `testTheMacAppAndItsExtensionShipOneVersion`,
// which reads `apps/mac` — a tree this workflow deliberately does not trigger
// on. Selecting the class would run a macOS assertion on an iOS-only change;
// selecting the method runs the iOS half and nothing else.
const IOS_GUARD_SELECTORS = [
  "IOSSurfaceGuardTests",
  "IOSPrivacyManifestTests",
  "IOSDistributionSigningTests",
  "IOSAppIconAssetTests",
  "BundleVersionTests/testTheIOSAppAndItsExtensionShipOneVersion",
];
/** The class half of a selector — what has to exist as a file on disk. */
const selectorClass = (selector) => String(selector).split("/")[0];
/** The method half, or `undefined` for a whole-class selector. */
const selectorMethod = (selector) => String(selector).split("/")[1];
/** An `apps/ios`-only change, as a path — the case section 6k exists for. */
const IOS_GUARD_SAMPLE = "apps/ios/Relayium.xcodeproj/project.pbxproj";
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
for (const [marker, home, what] of [
  [IOS_PROJECT, IOS, "the iOS app build"],
  [MACOS_PROJECT, MACOS, "the macOS app build"],
]) {
  const hosts = GOVERNED.map((g) => g.file).filter((file) => workflowBody(file).includes(marker));
  check(
    hosts.length === 1 && hosts[0] === home,
    `${what} (\`${marker}\`) runs in ${hosts.length ? hosts.join(", ") : "no governed workflow"}; `
    + `want exactly ${home}. Two hosts is a duplicated macOS runner and no new evidence; zero is `
    + `a platform that stopped being built at all.`,
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
    max: 90,
    why: "a PAID macOS runner is held by a build that will never finish — a simulator that never "
      + "boots, an acceptance child that never exits",
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
      // Declared 10. A checkout on most events; its one step is skipped
      // outside a workflow_dispatch, and only a release dispatch reaches
      // `xcodebuild -showBuildSettings`.
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
      // Declared 15. A free Linux runner, and the least recoverable job here.
      publish: {
        max: 20,
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

/** The platform roots that exist today, and the one workflow that owns each. */
const PLATFORM_OWNERS = [
  {
    label: "macOS",
    root: "apps/mac",
    workflow: MACOS,
    marker: MACOS_PROJECT,
    sample: "apps/mac/Relayium/AccountView.swift",
  },
  {
    label: "iOS",
    root: "apps/ios",
    workflow: IOS,
    marker: IOS_PROJECT,
    sample: "apps/ios/Relayium/RelayiumApp.swift",
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
  {
    label: "Android",
    root: "apps/android",
    workflow: "android.yml",
    sample: "apps/android/app/src/main/kotlin/Main.kt",
    build: /gradlew|gradle\b|sdkmanager|kotlinc|\badb\b/,
  },
  {
    label: "Windows",
    root: "apps/windows",
    workflow: "windows.yml",
    sample: "apps/windows/Relayium/App.xaml.cs",
    build: /msbuild|dotnet\s|cargo\s|cmake\b|signtool|Invoke-Pester/,
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
 * The Swift test target's own file names, read from disk.
 *
 * Section 6k names five guard SELECTORS that `ios.yml` must execute by
 * `--filter`. A filter naming a class that does not exist is not a smaller
 * gate, it is a `swift test` invocation matching nothing — so the names are
 * checked against the files that declare them, and carried in the world so
 * section 8 can delete one and require the complaint.
 */
const swiftTestFiles = (() => {
  try {
    return readdirSync(resolve(repoRoot, SWIFT_TEST_TARGET_DIR), { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".swift"))
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
})();

/**
 * `Class/method` for every XCTest case the target declares.
 *
 * The class-file check above is not enough for a `Class/method` selector: the
 * file can exist while the method it names has been renamed, and `swift test`
 * would then match NOTHING and exit 0. That is the same silent non-gate the
 * file check exists to prevent, one level in, so the method half is resolved
 * too rather than trusted to a one-off run at authoring time.
 *
 * A deliberately shallow scan, not a Swift parser: track the most recent
 * `class X:` declaration and attribute each `func testY(` that follows it. It
 * over-reports only if a nested type re-declares a `test…` method, which would
 * make a selector look resolvable that is not — so the assertion below is
 * paired with the class-file check rather than replacing it.
 */
const swiftTestMethods = (() => {
  const out = new Set();
  for (const name of swiftTestFiles) {
    let text;
    try {
      text = readFileSync(resolve(repoRoot, SWIFT_TEST_TARGET_DIR, name), "utf8");
    } catch {
      continue;
    }
    let current;
    for (const line of text.split("\n")) {
      const declared = line.match(/\bclass\s+([A-Za-z_][A-Za-z0-9_]*)\s*:/);
      if (declared) { current = declared[1]; continue; }
      const method = line.match(/\bfunc\s+(test[A-Za-z0-9_]*)\s*\(/);
      if (method && current) out.add(`${current}/${method[1]}`);
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
    testFiles: [...swiftTestFiles],
    testMethods: [...swiftTestMethods],
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
    need(
      hosts.length === 1 && hosts[0] === platform.workflow,
      `platform root ${platform.root}: the ${platform.label} app build (\`${platform.marker}\`) `
      + `runs in [${hosts.join(", ")}]; want exactly [${platform.workflow}]. A platform root has `
      + `exactly one heavy owner — two hosts is a second platform runner per commit and no new `
      + `evidence, zero is a platform that quietly stopped being built.`,
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
    need(
      spanned.length <= 1,
      `${file}'s path filter matches more than one platform root (${spanned.join(", ")}). One `
      + `workflow that starts on two platforms' source cannot be started for one of them alone, `
      + `no matter how its jobs are conditioned — path filters are per-workflow.`,
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
  for (const platform of PLATFORM_OWNERS) {
    const paths = wPaths(world, platform.workflow);
    if (paths === null) continue;
    need(
      paths.includes(`${SHARED_APPLE_ROOT}/**`),
      `${platform.workflow}'s path filter no longer names \`${SHARED_APPLE_ROOT}/**\`. Stated `
      + `separately from the fan-out check above so the reason survives a filter that happens to `
      + `match the shared package through some broader glob.`,
    );
  }
  for (const future of FUTURE_PLATFORMS) {
    if (!world.docs.has(future.workflow)) continue;
    need(
      !wTriggers(world, future.workflow, SHARED_APPLE_SAMPLE),
      `${future.workflow} triggers on ${SHARED_APPLE_ROOT}. That package is APPLE-SHARED, not `
      + `cross-platform: it is Swift, it links WebRTC and Sodium through SwiftPM, and nothing `
      + `outside macOS and iOS compiles it. A ${future.label} workflow watching it burns a runner `
      + `on every Apple change and proves nothing. Truly cross-platform contracts belong in `
      + `${COMPAT}.`,
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

// ── 6k. the iOS guard selectors an iOS-only pull request actually EXECUTES ──
//
// The same class of invisible gap as section 6, one level in. Section 6 governs
// which workflow a platform root STARTS; this governs what that workflow then
// runs, and the two are not the same claim.
//
// What was wrong: the guards that read `apps/ios/Relayium.xcodeproj`, its
// `PrivacyInfo.xcprivacy`, its signing configuration, its icon set and the
// version it shares with its share extension are XCTest cases in the SHARED
// SwiftPM package, not tests in the iOS project. `xcodebuild` never runs them.
// `swift test` runs in exactly one place — `macos.yml`'s `test` job — and
// `macos.yml`'s path filter deliberately EXCLUDES `apps/ios/**`, because
// section 5 split the two Apple platforms apart on purpose. So an iOS-only pull
// request compiled the app, drove its UI, ran three acceptance runs, and
// executed none of the guards written about the files it had just edited.
// Everything was green and nothing had read them.
//
// `ios.yml` now runs those five selectors by name. The failure modes that leave
// the YAML valid, in rough order of how plausible each is:
//
//   * a filter is dropped, and that guard silently stops running;
//   * every filter is dropped, and the step becomes the WHOLE 233-file suite on
//     a paid macOS runner — which reads as "more testing" while actually being
//     the change section 5 split the workflows to prevent;
//   * a selector survives a rename and now matches NOTHING, which `swift test`
//     reports as success;
//   * `|| true`, `continue-on-error` or an `if:` turns the step into a no-op
//     that reports nothing rather than red;
//   * the step's own bound goes away or is raised past the point of being a
//     bound, and a wedged `swift test` runs on toward the job's much larger
//     budget on a PAID runner;
//   * the carrier job's bound goes away too, and that wedged run holds the
//     runner for GitHub's six-hour default;
//   * the whole-suite run leaves `macos.yml`, so nothing runs it anywhere.
//
// Each is asserted, and section 8 mutates each one to prove the assertion fires.
//
// TWO BOUNDS, NESTED, AND BOTH GOVERNED. `timeout-minutes` is valid GitHub
// Actions syntax on a step as well as on a job, and here both are wanted,
// because they bound different things. The carrier job's budget covers the
// whole iOS lane — two `xcodebuild` graphs on a paid macOS runner — and section
// 6i justifies that number against measured runtime. This step compiles the
// shared package and reads files. Giving it only the job's budget would mean a
// wedged `swift test` sits on a PAID runner for the better part of the lane's
// whole allowance before anything reports red, so the step carries the tighter
// bound and the job keeps the outer one.
//
// Nesting is only safe while BOTH are checked, which is what this section does:
// the step's own `timeout-minutes` must be finite, positive and no larger than
// `IOS_GUARD_STEP_CEILING`, and the carrier job must still declare the finite
// budget inside the ceiling section 6i sets for `ios.yml` — read from
// `RUNNER_BUDGETS` below rather than restated here, so the two cannot disagree.
// Deleting either, or raising the step's until it no longer bounds anything, is
// mutated below.

/** The `--filter` arguments of a `swift test` command, in order. */
function swiftTestFilters(run) {
  return [...String(run).matchAll(/--filter[=\s]+['"]?([^'"\s\\]+)/g)].map((m) => m[1]);
}

/**
 * The largest `timeout-minutes` the iOS guard step may declare for itself.
 *
 * Not derived from anything, because there is nothing to derive it from: 6i
 * budgets JOBS against measured runtime and knows nothing about step keys. The
 * step's real work is a shared-package build plus five file-reading test
 * classes — minutes, not tens of minutes. 40 is chosen far enough above that to
 * absorb a cold SwiftPM build on a slow runner without ever firing on a healthy
 * run, and far enough below `ios-build`'s own budget that the step still fails
 * first when the run is wedged. Raising it past this is a decision about how
 * long a paid runner may sit on a hung `swift test`; make it here.
 */
const IOS_GUARD_STEP_CEILING = 40;

/**
 * The ceiling section 6i already holds `file`/`jobName` to, or `undefined`.
 *
 * Derived rather than restated: 6k asserts the guard step's carrier job is
 * bounded, and a second copy of the number here would be free to drift above
 * 6i's the day somebody edits one of them.
 */
function governedCeiling(file, jobName) {
  const budget = RUNNER_BUDGETS.find((entry) => entry.file === file);
  if (budget === undefined) return undefined;
  return budget.jobs === undefined ? budget.max : budget.jobs[jobName]?.max;
}

/**
 * `ios.yml`'s iOS guard step: the exact selectors, where the bound lives, and
 * the shapes that would turn the step into nothing.
 */
function iosGuardStepFailures(world) {
  const out = [];
  const need = (ok, message) => { if (!ok) out.push(message); };

  need(
    IOS_GUARD_SELECTORS.length > 0,
    `this policy names no iOS guard selectors at all, so every check below would pass by `
    + `inspecting an empty list.`,
  );

  const doc = world.docs.get(IOS);
  need(
    doc !== undefined,
    `${IOS} is missing or did not parse, so nothing here can say which tests an iOS-only pull `
    + `request runs.`,
  );
  if (!doc) return out;

  // Which job carries it, and the step itself. Selected by COMMAND rather than
  // by step name: the name is prose and may be reworded, while `swift test` is
  // the thing that either runs or does not.
  const carriers = [];
  for (const [jobName, job] of Object.entries(doc.jobs ?? {})) {
    for (const step of job.steps ?? []) {
      if (String(step?.run ?? "").includes("swift test")) carriers.push({ jobName, job, step });
    }
  }
  need(
    carriers.length > 0,
    `${IOS} runs no \`swift test\` at all. The iOS project, privacy, distribution, icon and `
    + `version guards [${IOS_GUARD_SELECTORS.join(", ")}] are XCTest cases in `
    + `${SWIFT_PACKAGE_DIR}, not tests in the Xcode project, so \`xcodebuild\` does not run them `
    + `— and ${MACOS}, the only other place \`swift test\` runs, does not trigger on `
    + `\`apps/ios/**\`. Without this step an iOS-only pull request compiles the app and accepts `
    + `its UI while nothing reads the project file, the privacy manifest, the signing `
    + `configuration, the icon set or the bundle version it just changed.`,
  );
  need(
    carriers.length <= 1,
    `${IOS} runs \`swift test\` in ${carriers.length} steps `
    + `(${carriers.map((c) => `${c.jobName}/${JSON.stringify(c.step?.name)}`).join(", ")}). `
    + `Which one is the guard gate is then a matter of reading order, and a filter dropped from `
    + `one of them is invisible. Keep it to one step.`,
  );
  if (carriers.length === 0) return out;

  const { jobName, job, step } = carriers[0];
  const run = String(step.run ?? "");
  const where = `${IOS}/${jobName}`;

  // The workflow has to START on an iOS-only change for any of this to matter.
  // Read through the compiled globs the rest of this file uses, so "the filter
  // was narrowed" fails here too rather than only in section 6.
  need(
    wTriggers(world, IOS, IOS_GUARD_SAMPLE),
    `${where}: ${IOS} runs the iOS guard selectors but does not trigger on ${IOS_GUARD_SAMPLE}, `
    + `so an iOS-only pull request never starts the job that runs them.`,
  );

  need(
    step["working-directory"] === SWIFT_PACKAGE_DIR,
    `${where}: the guard step's \`working-directory\` is `
    + `${JSON.stringify(step["working-directory"])}, want ${JSON.stringify(SWIFT_PACKAGE_DIR)}. `
    + `\`swift test\` resolves its package from the working directory; anywhere else it either `
    + `fails or tests a different package.`,
  );

  // The exact set, in both directions, by EQUALITY. A missing selector is a
  // guard that stopped running; an extra one is a scope change that has to be a
  // decision, made here, rather than a line added to a YAML file. Matching by
  // prefix instead would accept `…BundleVersionTests` — the whole class,
  // including its macOS case — as if it were the method this policy names.
  const filters = swiftTestFilters(run);
  const wanted = IOS_GUARD_SELECTORS.map((selector) => `${SWIFT_TEST_TARGET}.${selector}`);
  need(
    filters.length > 0,
    `${where}: the guard step runs \`swift test\` with NO \`--filter\`, which is the entire `
    + `${SWIFT_TEST_TARGET} suite — every WebRTC, account, realtime and localization case — on a `
    + `PAID macOS runner, started by every \`apps/ios/**\` change. That is not a stricter gate, `
    + `it is the whole-suite run section 5 moved out of this workflow. The unfiltered suite is `
    + `${MACOS}/test's job; this step runs [${IOS_GUARD_SELECTORS.join(", ")}].`,
  );
  for (const selector of IOS_GUARD_SELECTORS) {
    const want = `${SWIFT_TEST_TARGET}.${selector}`;
    need(
      filters.includes(want),
      `${where}: the guard step does not filter for exactly \`${want}\`. It runs `
      + `[${filters.join(", ") || "nothing"}]. That selector is a guard over \`apps/ios\` `
      + `inputs, and dropping it stops that guard running on the only workflow an iOS-only `
      + `change starts — silently, because a test that is not selected is not reported as `
      + `skipped, it is not reported at all.`,
    );
    const className = selectorClass(selector);
    need(
      world.testFiles.includes(`${className}.swift`),
      `${where}: the guard step filters for \`${want}\`, but `
      + `${SWIFT_TEST_TARGET_DIR}/${className}.swift does not exist. A \`--filter\` that matches `
      + `no test is not a smaller gate; either the class was renamed and this list has to follow `
      + `it, or it was deleted and that has to be a decision.`,
    );
    const method = selectorMethod(selector);
    need(
      method === undefined || world.testMethods.includes(`${className}/${method}`),
      `${where}: the guard step filters for \`${want}\`, but ${SWIFT_TEST_TARGET_DIR} declares no `
      + `\`${className}.${method}\`. \`swift test\` treats a filter that matches nothing as a `
      + `successful run of zero tests, so this is a guard that reports green while reading `
      + `nothing at all. Follow the rename here, or decide the case is gone.`,
    );
  }
  for (const filter of filters) {
    need(
      wanted.includes(filter),
      `${where}: the guard step filters for ${JSON.stringify(filter)}, which this policy does not `
      + `name; it names [${wanted.join(", ")}]. Widening what an \`apps/ios/**\` change runs on a `
      + `PAID macOS runner is a decision; make it by adding the selector to `
      + `\`IOS_GUARD_SELECTORS\` here, where the cost is visible, rather than by a line in a YAML `
      + `file. A pattern such as \`${SWIFT_TEST_TARGET}\` alone would match the whole suite, and `
      + `a bare \`${SWIFT_TEST_TARGET}.BundleVersionTests\` would pull in the macOS case this `
      + `workflow does not trigger on.`,
    );
  }

  // The two ways to keep the step and remove the gate.
  need(
    !/\|\|\s*true/.test(run) && !/;\s*exit\s+0/.test(run),
    `${where}: the guard step's command swallows its own failure `
    + `(${JSON.stringify(run.trim())}). A gate that cannot report red is not a gate — and a step `
    + `that always succeeds is invisible in the merge box, exactly like the \`[macos-only]\` `
    + `marker section 6i removed from this file.`,
  );
  need(
    step["continue-on-error"] !== true && job["continue-on-error"] !== true,
    `${where}: the guard step or its job sets \`continue-on-error: true\`, so a failing guard `
    + `reports green.`,
  );
  need(
    step.if === undefined,
    `${where}: the guard step carries \`if: ${step.if}\`. A conditional gate is the escape hatch `
    + `section 6i removed from this workflow: a skipped step does not report red, it reports `
    + `nothing, and the merge box reads that as "not a problem".`,
  );

  // The inner bound, on the step. See the section note above: it is the one
  // that fires first on a wedged run, and it is checked here because section 6i
  // budgets jobs and cannot see step keys.
  const stepBound = Number(step["timeout-minutes"]);
  need(
    Number.isFinite(stepBound) && stepBound > 0,
    `${where}: the guard step declares \`timeout-minutes: `
    + `${JSON.stringify(step["timeout-minutes"])}\`, want a finite positive number. \`swift `
    + `test\` here compiles the shared package and reads files; without its own bound a wedged `
    + `run falls back to the carrier job's much larger budget and sits on a PAID macOS runner `
    + `for most of the iOS lane's whole allowance before the board turns red. The job's bound is `
    + `checked separately below and does not replace this one.`,
  );
  need(
    !(Number.isFinite(stepBound) && stepBound > IOS_GUARD_STEP_CEILING),
    `${where}: the guard step is bounded at `
    + `${JSON.stringify(step["timeout-minutes"])} minutes, above the `
    + `${IOS_GUARD_STEP_CEILING}-minute ceiling this section sets for it. The step's work is a `
    + `shared-package build and five file-reading test classes; a bound that large no longer `
    + `bounds it, and the wedged run it is supposed to cut short would instead be left to the `
    + `carrier job. Either the step grew work that belongs elsewhere, or the number was raised `
    + `to make a slow run pass — both are decisions, and \`IOS_GUARD_STEP_CEILING\` is where to `
    + `make them.`,
  );

  // And the outer bound, on the carrier job — independently governed by section
  // 6i. The step's bound above does not stand in for it: a step key bounds one
  // step, while everything else in this job, including two `xcodebuild` graphs,
  // is held by the job's budget alone.
  const ceiling = governedCeiling(IOS, jobName);
  need(
    Number.isFinite(ceiling),
    `${where}: section 6i declares no runner-budget ceiling for this job `
    + `(\`RUNNER_BUDGETS\` gives ${String(ceiling)}), so the bound check below has nothing to `
    + `compare against and would pass by not comparing. 6k deliberately reads 6i's number rather `
    + `than carrying its own; if the budget moved or was renamed, this has to follow it.`,
  );
  const resolved = timeoutValues(job);
  need(
    resolved.unresolved === undefined,
    `${where}: the guard step's carrier job reads \`matrix.${resolved.unresolved}\` for its `
    + `\`timeout-minutes\` and declares no \`strategy.matrix.include\` to resolve it against, so `
    + `the guard step has no readable bound at all and falls back to GitHub's 6-hour default.`,
  );
  const values = resolved.values ?? [];
  need(
    resolved.unresolved !== undefined || values.length > 0,
    `${where}: the guard step's carrier job resolved to no \`timeout-minutes\` values at all, so `
    + `every bound assertion below would pass by iterating over nothing.`,
  );
  for (const { declared, value } of values) {
    need(
      Number.isFinite(value) && value > 0,
      `${where}: the guard step's carrier job declares \`timeout-minutes: ${declared}\`, want a `
      + `finite positive number. This step is the guard gate's only home and the job is its only `
      + `bound; undeclared, a wedged \`swift test\` holds a PAID macOS runner for GitHub's `
      + `6-hour default.`,
    );
    need(
      !Number.isFinite(ceiling) || !(Number.isFinite(value) && value > ceiling),
      `${where}: the guard step's carrier job is bounded at ${declared} minutes, outside the `
      + `${ceiling}-minute ceiling section 6i budgets for ${IOS}. The guard step inherits that `
      + `bound and nothing narrower, so a bound that large is the 6-hour default wearing a `
      + `number.`,
    );
  }

  // Filtering here is only safe while the FULL suite still runs somewhere, and
  // that premise is asserted in `scripts/test/swift-ci-boundary-test.mjs`,
  // which owns the shared package's CI ownership: exactly ONE unfiltered
  // `swift test` exists in this repository, it is `swift-package.yml`'s
  // `swift-test` job, and it runs from `apps/RelayiumKit`. That is strictly
  // stronger than the rule that used to live here — which only asked whether
  // `macos.yml` still ran one — and it is hosted by the same always-on
  // `repo-hygiene.yml` this policy is.

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
      if (!String(job?.["runs-on"] ?? "").startsWith("macos")) continue;
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
];

/** The jobs each half declares, exactly. */
const CI_JOBS = ["contract", "test", "ui-smoke", "signed-build"];
const RELEASE_JOBS = ["build", "notarize-stage", "publish"];

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
    + `[${DISPATCH_INPUTS.map((input) => input.name).join(", ")}], in that order. These are the `
    + `operator's five controls and they MOVED here from ${MACOS}; an input dropped in the move `
    + `is a decision that can no longer be made, and one added is a lever with no history behind `
    + `its default.`,
  );
  for (const want of DISPATCH_INPUTS) {
    const input = dispatch && typeof dispatch === "object" ? dispatch.inputs?.[want.name] : undefined;
    if (input === undefined || typeof input !== "object") continue;
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
      build.permissions === undefined,
      `${MACOS_RELEASE}/build declares \`permissions: ${JSON.stringify(build.permissions)}\`. A `
      + `caller's permission block is passed to the called workflow; the CI half is read-only and `
      + `must stay that way when a release run is what started it.`,
    );
  }

  // The two release stages: order, guard, and the artifact they actually read.
  const notarize = release.jobs?.["notarize-stage"];
  if (notarize) {
    need(
      notarize.needs === "build",
      `${MACOS_RELEASE}/notarize-stage declares \`needs: ${JSON.stringify(notarize.needs)}\`, want `
      + `\`build\`. Depending on the CALL means depending on every job inside it — \`contract\`, `
      + `\`test\`, \`ui-smoke\` and \`signed-build\` — so nothing here can start while any part of `
      + `the macOS gate is red. Naming individual jobs of a called workflow is not possible, and `
      + `naming nothing would let a notarization run against a failed build.`,
    );
    const steps = notarize.steps ?? [];
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
        "pull-requests": "write",
      }),
      `${MACOS_RELEASE}/publish declares permissions ${JSON.stringify(publish.permissions)}, want `
      + `the exact release-delivery permission set. It needs contents to push the frozen branch, `
      + `pull requests to bind that branch to protected main, and actions only to dispatch the `
      + `required gate on the candidate SHA. These stay on the publish job, not the workflow.`,
    );
  }
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
    deepEqual(Object.keys(gateDispatchInputs), ["pr_number", "base_sha", "head_sha"]),
    `${AGGREGATE}'s workflow_dispatch inputs are [${Object.keys(gateDispatchInputs).join(", ")}]; `
    + `want exactly [pr_number, base_sha, head_sha]. Those three values bind a manually started `
    + `check to one frozen candidate rather than providing a general-purpose green status.`,
  );
  for (const name of ["pr_number", "base_sha", "head_sha"]) {
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

for (const message of triggerFailures(realWorld())) failures.push(message);
for (const message of platformBoundaryFailures(realWorld())) failures.push(message);
for (const message of pathMatrixFailures(realWorld())) failures.push(message);
for (const message of fuzzCampaignFailures(realWorld())) failures.push(message);
for (const message of iosGuardStepFailures(realWorld())) failures.push(message);
for (const message of macosBudgetFailures(realWorld())) failures.push(message);
for (const message of concurrencyFailures(realWorld())) failures.push(message);
for (const message of releaseBoundaryFailures(realWorld())) failures.push(message);
for (const message of aggregateGateFailures(realWorld())) failures.push(message);
for (const message of compatEntryPointFailures(realWorld())) failures.push(message);

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
  world.governed.push({ file, dispatch: true });
  return world;
}

const ANDROID = FUTURE_PLATFORMS.find((future) => future.root === "apps/android");

/** A governed workflow that is parsed, and a real one that deliberately is not. */
const WEB = "web.yml";
const CONTRACTS = "contracts.yml";
const OPS_DEPLOY_CONTRACT = "ops-deploy-contract.yml";
const AUTO_RELEASE = "auto-release.yml";

/**
 * Mutate `ios.yml`'s iOS guard step, and the job carrying it.
 *
 * Throws when no such step exists, for the same reason `withCommandJob` does: a
 * mutation that silently stopped applying leaves the world unbroken, and the
 * case below it then passes while asserting nothing.
 */
function withGuardStep(world, mutate) {
  for (const [name, job] of Object.entries(world.docs.get(IOS)?.jobs ?? {})) {
    const steps = job.steps ?? [];
    const at = steps.findIndex((step) => String(step?.run ?? "").includes("swift test"));
    if (at !== -1) { mutate(steps[at], job, steps, at, name); return world; }
  }
  throw new Error(
    `no step in ${IOS} runs \`swift test\`, so the iOS guard gate this case is about is already `
    + `gone and the case cannot prove anything about it.`,
  );
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
  {
    name: "an apps/android root appears with no android.yml",
    mutate: (world) => { world.roots.add("apps/android"); return world; },
    expect: /apps\/android\/ exists but \.github\/workflows\/android\.yml does not/,
  },
  {
    name: "an android.yml placeholder appears with no apps/android source",
    mutate: (world) => addWorkflow(world, ANDROID.workflow, syntheticPlatform({
      workflow: ANDROID.workflow, root: ANDROID.root, run: "./gradlew assembleDebug",
    })),
    expect: /android\.yml exists but apps\/android\/ does not/,
  },
  {
    name: "android.yml and apps/android both exist, but the job only echoes",
    mutate: (world) => {
      world.roots.add(ANDROID.root);
      return addWorkflow(world, ANDROID.workflow, syntheticPlatform({
        workflow: ANDROID.workflow, root: ANDROID.root, run: 'echo "android build: TODO"',
      }));
    },
    expect: /android\.yml has no job that actually builds or tests apps\/android/,
  },
  {
    name: "android.yml exists but its filter names the wrong root",
    mutate: (world) => {
      world.roots.add(ANDROID.root);
      addWorkflow(world, ANDROID.workflow, syntheticPlatform({
        workflow: ANDROID.workflow, root: ANDROID.root, run: "./gradlew assembleDebug",
      }));
      return withPaths(world, ANDROID.workflow, [
        "apps/mac/**", `.github/workflows/${ANDROID.workflow}`,
      ]);
    },
    expect: /android\.yml does not trigger on its own root apps\/android/,
  },
  {
    name: "android.yml claims the Apple-shared package as cross-platform",
    mutate: (world) => {
      world.roots.add(ANDROID.root);
      addWorkflow(world, ANDROID.workflow, syntheticPlatform({
        workflow: ANDROID.workflow, root: ANDROID.root, run: "./gradlew assembleDebug",
      }));
      return withPaths(world, ANDROID.workflow, [
        "apps/android/**", "apps/RelayiumKit/**", `.github/workflows/${ANDROID.workflow}`,
      ]);
    },
    expect: /android\.yml triggers on apps\/RelayiumKit/,
  },
  {
    name: "android.yml's build job loses its timeout",
    mutate: (world) => {
      world.roots.add(ANDROID.root);
      addWorkflow(world, ANDROID.workflow, syntheticPlatform({
        workflow: ANDROID.workflow, root: ANDROID.root, run: "./gradlew assembleDebug",
      }));
      return withJob(world, ANDROID.workflow, (job) => { delete job["timeout-minutes"]; });
    },
    expect: /android\.yml\/build: timeout-minutes is undefined/,
  },
  {
    name: "android.yml's build job becomes advisory",
    mutate: (world) => {
      world.roots.add(ANDROID.root);
      addWorkflow(world, ANDROID.workflow, syntheticPlatform({
        workflow: ANDROID.workflow, root: ANDROID.root, run: "./gradlew assembleDebug",
      }));
      return withJob(world, ANDROID.workflow, (job) => { job["continue-on-error"] = "true"; });
    },
    expect: /android\.yml\/build: continue-on-error makes this platform's gate advisory/,
  },
  {
    name: "android.yml's build job retries until it agrees",
    mutate: (world) => {
      world.roots.add(ANDROID.root);
      addWorkflow(world, ANDROID.workflow, syntheticPlatform({
        workflow: ANDROID.workflow,
        root: ANDROID.root,
        run: "./gradlew assembleDebug || ./gradlew assembleDebug # retry once",
      }));
      return world;
    },
    expect: /android\.yml\/build: a retry appeared/,
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
    mutate: (world) => withJob(world, IOS, (job) => {
      job.steps[job.steps.length - 1].if = "failure()";
    }),
    refute: /ios\.yml\/ios-build: a condition reads the commit message/,
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
    expect: /compat\.yml declares no job named `wire-vectors`; it declares \[vectors\]/,
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
    mutate: (world) => withCommandJob(world, "go.yml", "go test ./...", (job, step) => {
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
    mutate: (world) => withCommandJob(world, "go.yml", "go test ./...", (job, step) => {
      step.run = `${String(step.run).trimEnd()}\n${FUZZ_INVENTORY}\n`;
    }),
    refute: /go\.yml\/test runs a timed fuzz campaign/,
  },

  // ── the iOS guard gate (6k) ──────────────────────────────────────────────
  {
    // The most likely edit of all: one line deleted from a six-line command,
    // in a diff that still shows `swift test` running.
    name: "ios.yml drops one class from the iOS guard filter",
    mutate: (world) => withGuardStep(world, (step) => {
      step.run = String(step.run)
        .split("\n")
        .filter((line) => !line.includes("IOSPrivacyManifestTests"))
        .join("\n");
    }),
    expect: /does not filter for exactly `RelayiumKitTests\.IOSPrivacyManifestTests`/,
  },
  {
    // The same edit against the one selector that is a METHOD. It is the most
    // droppable line in the command — the longest, the odd one out, and the
    // only one whose class is already covered by `macos.yml`'s unfiltered run,
    // so losing it looks like deduplication rather than a hole.
    name: "ios.yml drops the iOS bundle-version method from the guard filter",
    mutate: (world) => withGuardStep(world, (step) => {
      step.run = String(step.run)
        .split("\n")
        .filter((line) => !line.includes("testTheIOSAppAndItsExtensionShipOneVersion"))
        .join("\n");
    }),
    expect: /does not filter for exactly `RelayiumKitTests\.BundleVersionTests\/testTheIOSAppAndItsExtensionShipOneVersion`/,
  },
  {
    // Widening the method selector back to its class is not "more coverage":
    // it drags `testTheMacAppAndItsExtensionShipOneVersion` — which reads
    // `apps/mac`, a tree this workflow does not trigger on — onto every
    // iOS-only pull request.
    name: "ios.yml widens the version method selector to its whole class",
    mutate: (world) => withGuardStep(world, (step) => {
      step.run = String(step.run)
        .replace("BundleVersionTests/testTheIOSAppAndItsExtensionShipOneVersion",
          "BundleVersionTests");
    }),
    expect: /filters for "RelayiumKitTests\.BundleVersionTests", which this policy does not name/,
  },
  {
    // The rename that leaves the YAML valid and the gate empty: `swift test`
    // treats a filter matching nothing as a successful run of zero tests.
    name: "the guard's version method is renamed out from under its filter",
    mutate: (world) => {
      world.testMethods = world.testMethods
        .filter((name) => name !== "BundleVersionTests/testTheIOSAppAndItsExtensionShipOneVersion");
      return world;
    },
    expect: /declares no `BundleVersionTests\.testTheIOSAppAndItsExtensionShipOneVersion`/,
  },
  {
    // The opposite failure, and the expensive one: the gate is "strengthened"
    // into the whole 233-file suite on a paid runner, started by every
    // `apps/ios/**` change — undoing the native split from the inside.
    name: "ios.yml's guard step loses every filter and runs the whole suite",
    mutate: (world) => withGuardStep(world, (step) => { step.run = "swift test\n"; }),
    expect: /runs `swift test` with NO `--filter`/,
  },
  {
    name: "ios.yml's guard filter is widened to the whole test target",
    mutate: (world) => withGuardStep(world, (step) => {
      step.run = "swift test --filter 'RelayiumKitTests'\n";
    }),
    expect: /filters for "RelayiumKitTests", which this policy does not name/,
  },
  {
    name: "ios.yml's guard step swallows its own failure",
    mutate: (world) => withGuardStep(world, (step) => {
      step.run = `${String(step.run).trimEnd()} || true\n`;
    }),
    expect: /swallows its own failure/,
  },
  {
    name: "ios.yml's guard step is made advisory with continue-on-error",
    mutate: (world) => withGuardStep(world, (step) => { step["continue-on-error"] = true; }),
    expect: /continue-on-error: true`, so a failing guard/,
  },
  {
    name: "ios.yml's guard step regains a commit-message-shaped escape hatch",
    mutate: (world) => withGuardStep(world, (step) => {
      step.if = "!contains(github.event.head_commit.message, '[skip-guards]')";
    }),
    expect: /carries `if: /,
  },
  {
    // The inner bound goes away and the wedged run is left to the job's much
    // larger budget. Nothing else in the step's shape changes, so this is the
    // deletion that reads as tidying up a duplicate.
    name: "ios.yml's guard step loses its own bound",
    mutate: (world) => withGuardStep(world, (step) => { delete step["timeout-minutes"]; }),
    expect: /the guard step declares `timeout-minutes: undefined`, want a finite positive number/,
  },
  {
    // And the same bound kept but raised until it stops being one — the shape a
    // "just make CI pass" edit takes, which an undefined-check alone would miss.
    name: "ios.yml's guard step raises its bound past the point of bounding anything",
    mutate: (world) => withGuardStep(world, (step) => { step["timeout-minutes"] = 70; }),
    expect: /the guard step is bounded at 70 minutes, above the 40-minute ceiling/,
  },
  {
    name: "the guard step's carrier job loses its finite bound",
    mutate: (world) => withGuardStep(world, (step, job) => { delete job["timeout-minutes"]; }),
    expect: /the guard step's carrier job declares `timeout-minutes: undefined`, want a finite positive number/,
  },
  {
    name: "the guard step's carrier job is bounded outside its governed ceiling",
    mutate: (world) => withGuardStep(world, (step, job) => { job["timeout-minutes"] = 300; }),
    expect: /the guard step's carrier job is bounded at 300 minutes, outside the 90-minute ceiling/,
  },
  {
    name: "the iOS guard step is deleted outright",
    mutate: (world) => withGuardStep(world, (step, job, steps, at) => { steps.splice(at, 1); }),
    expect: /ios\.yml runs no `swift test` at all/,
  },
  {
    name: "ios.yml stops triggering on the iOS project it runs guards over",
    mutate: (world) => withPaths(world, IOS, [
      "apps/RelayiumKit/**", `.github/workflows/${IOS}`,
    ]),
    expect: /runs the iOS guard selectors but does not trigger on apps\/ios/,
  },
  {
    name: "a filtered guard class no longer exists in the test target",
    mutate: (world) => {
      world.testFiles = world.testFiles.filter((name) => name !== "IOSAppIconAssetTests.swift");
      return world;
    },
    expect: /IOSAppIconAssetTests\.swift does not exist/,
  },
  {
    name: "the class behind the method selector no longer exists in the test target",
    mutate: (world) => {
      world.testFiles = world.testFiles.filter((name) => name !== "BundleVersionTests.swift");
      return world;
    },
    expect: /BundleVersionTests\.swift does not exist/,
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
    mutate: (world) => withGateRule(world, "swift-package native-web-pairing", "native-web-pairing"),
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
  // The two cases that used to sit here — `macos.yml`'s unfiltered `swift test`
  // gaining a `--filter`, and a legitimate fast pre-check beside it — moved
  // with their rule to `scripts/test/swift-ci-boundary-test.mjs`, which now
  // owns where that command may live and mutates both shapes there.
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
      ...iosGuardStepFailures(world),
      ...macosBudgetFailures(world),
      ...concurrencyFailures(world),
      ...releaseBoundaryFailures(world),
      ...aggregateGateFailures(world),
      ...compatEntryPointFailures(world),
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
