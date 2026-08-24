#!/usr/bin/env node
// scripts/test/swift-ci-boundary-test.mjs — who owns the shared Swift package,
// and what a change inside it is allowed to cost.
//
// ## The failure this file exists for
//
// `apps/RelayiumKit/` is one directory and three different kinds of input.
// `Sources/`, `Package.swift` and `Package.resolved` are compiled by both app
// targets and by the pairing acceptance's `LocalTransferPeer`. `Tests/` is
// compiled by nothing else at all: `xcodebuild` builds the package's LIBRARY
// PRODUCTS and never its test target, no release script under
// `apps/mac/scripts/` opens a file in it, and `swift build --product
// LocalTransferPeer` does not build it either.
//
// Path filters in GitHub Actions are per-WORKFLOW, never per-job. So while the
// repository's only unfiltered `swift test` lived inside `macos.yml`'s `test`
// job, the package's own suite could be started only by starting the macOS
// workflow — and the package's tests therefore had to be in the macOS
// workflow's filter. `ios.yml` and `native-web-pairing.yml` carried the same
// tree for the same reason. One added XCTest case started two full `xcodebuild`
// graphs, a simulator UI smoke, three acceptance runs and a 45-minute
// Swift + Go + Chrome pairing runner, and not one of them could observe it.
//
// The repair has two halves, and either alone is a regression:
//
//   * the suite moved to `swift-package.yml`, which watches the WHOLE package
//     with no exclusion and is the sole owner of an unfiltered `swift test`;
//   * `macos.yml`, `ios.yml` and `native-web-pairing.yml` keep
//     `apps/RelayiumKit/**` and follow it with `!apps/RelayiumKit/Tests/**`.
//
// Drop the negation and the cost returns. Drop the workflow and the package's
// own tests run nowhere while the negation keeps the heavy lanes from noticing.
// Both are asserted here, together, because they are one decision.
//
// ## Why this is its own file
//
// `ci-event-policy-test.mjs` governs properties every workflow has — which
// events start it, which runs may cancel which, whether a paid runner is
// budgeted at all. This file governs one subtree's ownership. Keeping them
// apart is not tidiness: the trigger policy is already the largest guard in the
// repository, and a Swift-specific contract buried inside it is a contract
// nobody finds when the package moves.
//
// ## Why order is load-bearing, and why filters are COMPILED here
//
// GitHub evaluates a `paths:` list against each changed file, IN ORDER, and the
// LAST pattern that matches decides. A `!` entry excludes; a later positive
// entry re-includes what an earlier `!` excluded; a file no pattern matches
// does not match at all.
//
// That makes three edits invisible to list membership, to YAML validity and to
// `actionlint`, and each of them silently restores the runs this boundary
// removes: the two lines SWAPPED (the exclusion is overridden by the pattern it
// qualifies), a positive glob added BELOW the exclusion (the fixtures come back
// into a 45-minute macOS runner that never opens one), and an exclusion that is
// present, correctly ordered and simply WRONG (`!…/Tests/Fixtures/**`, a
// renamed directory). So every rule below that is about behaviour compiles the
// filter and evaluates it the way GitHub does, and section 6 mutates each of
// those three shapes to prove the rule sees it.
//
// ## What a MIXED diff does, and why that is asserted too
//
// A commit touching package source AND package tests still starts every heavy
// lane, because the source file is still a positive match and one matching file
// is enough to start a workflow. This boundary is about test-ONLY and
// fixture-ONLY changes; it must never make a real source change cheaper to
// merge. A "further optimisation" that turned it into a source-change skip
// would be a real regression wearing this file's clothes, so the legitimate
// case is asserted rather than assumed.
//
// ## Why the YAML parser is written out here
//
// Same reason as `ci-event-policy-test.mjs`, `macos-publish-order-test.mjs` and
// `native-web-pairing-gate-test.mjs`: `web/` is the only Node project in this
// repository, and a guard that runs on every pull request must not need
// `npm ci` first. The parser covers the subset these workflows use and THROWS
// on anything it does not understand rather than guessing, and it is proved
// against an embedded fixture before anything it produces is trusted — a
// mis-read workflow is the one thing that could make every rule below pass
// vacuously.

import { readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const workflowsDir = resolve(repoRoot, ".github/workflows");

const failures = [];
function check(ok, message) {
  if (ok) return;
  failures.push(message);
}

// ── the subjects, stated once ───────────────────────────────────────────────

const SWIFT_PACKAGE_DIR = "apps/RelayiumKit";
const SWIFT_TEST_TARGET = "RelayiumKitTests";
const PACKAGE_SOURCE_GLOB = `${SWIFT_PACKAGE_DIR}/**`;
const PACKAGE_TESTS_ROOT = `${SWIFT_PACKAGE_DIR}/Tests`;
const PACKAGE_TESTS_GLOB = `${PACKAGE_TESTS_ROOT}/**`;
const PACKAGE_TESTS_NEGATION = `!${PACKAGE_TESTS_GLOB}`;
const PACKAGE_FIXTURES_ROOT = `${PACKAGE_TESTS_ROOT}/Fixtures`;
const PACKAGE_TEST_DIR = `${PACKAGE_TESTS_ROOT}/${SWIFT_TEST_TARGET}`;

const SWIFT_PACKAGE = "swift-package.yml";
const SWIFT_PACKAGE_JOB = "swift-test";
const MACOS = "macos.yml";
const IOS = "ios.yml";
const NWP = "native-web-pairing.yml";
const GO = "go.yml";
const WEB = "web.yml";
const AUTO_RELEASE = "auto-release.yml";

/**
 * The root contract lane, and the ONE `swift test` it is allowed to run.
 *
 * `contracts.yml` is a third host for `swift test` and therefore a third PAID
 * macOS runner. It is here rather than refused because the alternative was
 * worse in both available shapes: widening `swift-package.yml`'s filter to a
 * tree it does not compile would spend the WHOLE package suite on a document
 * edit, and leaving the Swift consumer out entirely would let a contract change
 * land with two implementations compared and the third not — which is the same
 * "fails later against an innocent commit" shape the fixture entries in `go.yml`
 * and `web.yml` exist to prevent.
 *
 * What that costs is bounded HERE, and the bound is the point of the rules in
 * section 1f: this host's `swift test` must always carry a `--filter`, and the
 * filter must select exactly the contract test class. An unfiltered one would
 * run the whole package suite on a document edit; a broader selector would grow
 * this lane into a second package suite one `--filter` argument at a time.
 */
const CONTRACTS = "contracts.yml";
const CONTRACTS_SWIFT_JOB = "swift-contract";
const CONTRACTS_SWIFT_FILTER = `${SWIFT_TEST_TARGET}.DeviceInboxAdmissionContractTests`;

/**
 * The product↔ops deploy contract's lane.
 *
 * It has NO Swift opinion at all — one Ubuntu job running one `go test`
 * selector — and it is named here for exactly that reason. Section 1's closed-set
 * rule requires every path-filtered workflow in the repository to be in `PARSED`,
 * because "no workflow but `swift-package.yml` starts on an ordinary Swift test"
 * is a claim about ALL of them and a lane outside the list is a lane the claim
 * was never checked against. Registering it here is what keeps that set closed;
 * it grants the lane nothing, and the Swift rules below simply find nothing in
 * it to complain about — which is the correct answer for a lane that must never
 * grow a macOS runner.
 */
const OPS_DEPLOY_CONTRACT = "ops-deploy-contract.yml";

/**
 * The aggregate merge gate, and the caller job id `swift-package.yml` is called
 * under.
 *
 * The package lane used to carry its own `pull_request:` trigger, aliased to
 * the same `&paths` anchor as `push`, and a rule here compared the two lists.
 * That trigger is gone. The reason is not tidiness: a path-filtered workflow
 * that does not trigger emits NO check run at all, so branch protection could
 * never tell "the package suite passed" from "the package suite was legitimately
 * not selected" from "the package suite never ran" — and a filtered lane that
 * reports nothing cannot be required. `merge-gate.yml` runs unfiltered on every
 * pull request, CALLS each lane, and reports the one always-present context.
 *
 * So the symmetry rule is REPLACED, not dropped, and by a stronger claim: the
 * lane declares `workflow_call:`, declares no `pull_request:`, and the gate
 * really calls it on an unfiltered pull-request trigger. All three are read
 * from `merge-gate.yml` on disk in section 1b, because "the gate covers it" is
 * precisely the assumption that decays into a package suite nothing runs on a
 * branch — the failure this whole file exists for, one level up.
 *
 * It is deliberately NOT in `PARSED`: that list is the closed set of PATH-
 * FILTERED workflows section 1a compares against the repository, and the gate
 * has no filter at all. It is parsed alongside them instead.
 */
const AGGREGATE = "merge-gate.yml";
const SWIFT_PACKAGE_GATE_JOB = "swift-package";
const SELF_HOST_GATE_JOB = "repo-hygiene";

/** This file, and the unfiltered workflow that has to execute it. */
const SELF_TEST = "scripts/test/swift-ci-boundary-test.mjs";
const SELF_HOST = "repo-hygiene.yml";
const SELF_COMMAND = `node ${SELF_TEST}`;
/** Minutes. This parses nine small YAML documents and reads six files; it needs seconds. */
const SELF_TIMEOUT_MAX = 5;

/**
 * The path-filtered workflows this boundary reasons about.
 *
 * Named explicitly, because the rules below are statements about a CLOSED set:
 * "no workflow but `swift-package.yml` starts on an ordinary Swift test" is a
 * claim about all of them, and a workflow silently dropped from this list would
 * stop being checked. `PARSED` therefore includes every filtered workflow in the
 * repository, not only the ones with a Swift opinion, and section 1 asserts that
 * the list still matches what is on disk.
 */
const PARSED = [
  SWIFT_PACKAGE, MACOS, IOS, NWP, GO, WEB, CONTRACTS, OPS_DEPLOY_CONTRACT, "compat.yml", SELF_HOST,
];

/**
 * The workflows that must NOT start for a change confined to the package's test
 * target: every lane that costs a macOS runner and reads nothing under it.
 *
 * `swift-package.yml` is deliberately absent — it is the one that must start.
 */
const HEAVY_CONSUMERS = [MACOS, IOS, NWP];

/**
 * The fixtures inside the excluded subtree that OTHER languages read, the file
 * that reads each, and the workflow that runs it.
 *
 * `!apps/RelayiumKit/Tests/**` removes the whole test target from three heavy
 * filters, and `apps/RelayiumKit/Tests/Fixtures/` is inside it. That is correct
 * for macOS, iOS and the pairing acceptance, none of which opens a fixture — and
 * WRONG for `go.yml` and `web.yml`, whose tests read these exact files from disk
 * and assert their own implementation still agrees with the frozen bytes. So
 * those two workflows name the individual paths.
 *
 * Every entry was read out of the consuming test rather than assumed, and the
 * consumer's source is read again on every run so the claim is PROVED rather
 * than repeated. A fixture whose consumer stopped reading it is a filter
 * charging a whole suite for a file nobody opens; a consumer whose fixture left
 * the filter is half a cross-language contract landing unchecked and failing
 * later against an innocent commit.
 */
const FIXTURE_INPUTS = [
  {
    fixture: `${PACKAGE_FIXTURES_ROOT}/device-inbox-manifest-v3-vectors.json`,
    consumers: [
      {
        file: "server/internal/inboxmanifest/vectors_test.go",
        workflow: GO,
        what: "the Go device-inbox manifest implementation's frozen-vector suite",
      },
      {
        file: "web/src/lib/inbox-manifest.test.ts",
        workflow: WEB,
        what: "the TypeScript device-inbox manifest suite",
      },
    ],
  },
  {
    fixture: `${PACKAGE_FIXTURES_ROOT}/crypto-vectors.json`,
    consumers: [
      { file: "web/src/lib/caps-vectors.test.ts", workflow: WEB, what: "the capability vectors" },
      { file: "web/src/lib/text-vectors.test.ts", workflow: WEB, what: "the text-transfer keys" },
    ],
  },
  {
    fixture: `${PACKAGE_FIXTURES_ROOT}/realtime-wire-vectors.json`,
    consumers: [
      { file: "web/src/lib/caps-vectors.test.ts", workflow: WEB, what: "the realtime wire frames" },
      { file: "web/src/lib/text-vectors.test.ts", workflow: WEB, what: "the text frame block" },
    ],
  },
];

/**
 * Fixtures no filtered workflow outside the package's own lane may start on,
 * and why each is on the list.
 *
 * Stated so "not listed" cannot decay into "listed again by whoever finds the
 * omission surprising".
 */
const FIXTURE_NON_INPUTS = [
  {
    fixture: `${PACKAGE_FIXTURES_ROOT}/store-wire-vectors.json`,
    why: "its only non-Swift consumer is `web/scripts/check-wire-vectors.mjs`, which runs in the "
      + "unfiltered `compat.yml` — a workflow with no path filter cannot be made to miss a file, "
      + "so naming it in a filtered one buys a full web suite for nothing",
  },
  {
    fixture: `${PACKAGE_FIXTURES_ROOT}/account/me.json`,
    why: "it is a Swift-only account fixture, nested a directory deeper than the vectors, so it "
      + "also proves the exclusion is not a `Tests/Fixtures/*` that misses subdirectories",
  },
];

/**
 * The globs a filtered workflow must never use to reach those fixtures.
 *
 * Each would re-include the whole excluded subtree, or most of it, and undo the
 * isolation by the back door — while looking, in a diff, like the narrow entry
 * beside it.
 */
const FIXTURE_TREE_GLOBS = [
  PACKAGE_TESTS_GLOB,
  `${PACKAGE_FIXTURES_ROOT}/**`,
  `${PACKAGE_FIXTURES_ROOT}/*`,
  `${PACKAGE_FIXTURES_ROOT}/*.json`,
];

/**
 * Real package paths, and the exact set of path-filtered workflows each must
 * start.
 *
 * This is the boundary as BEHAVIOUR: every row is compiled and evaluated the way
 * GitHub does it, and the expected set is exact in both directions, because a
 * missing run and a surplus run are the same edit made in opposite directions.
 * A file with no owner at all is the worst of the three — it can only be broken
 * and discovered later, against a commit that did not break it — so the sets are
 * written out rather than derived.
 */
const OWNERSHIP = [
  [`${SWIFT_PACKAGE_DIR}/Sources/RelayiumKit/Crypto/SealedBox.swift`, [IOS, MACOS, NWP, SWIFT_PACKAGE],
    "SHARED source. Every Apple consumer compiles it, the pairing acceptance links it, and the "
    + "package's own suite covers it. The Tests negation must not reach this file"],
  [`${SWIFT_PACKAGE_DIR}/Sources/RelayiumAppKit/LinkWorkspaceModel.swift`, [IOS, MACOS, NWP, SWIFT_PACKAGE],
    "the same, one product deeper: the macOS app is SwiftUI over `RelayiumAppKit`, and the "
    + "pairing acceptance's `LocalTransferPeer` is this model assembled by `AppEnvironment`. A "
    + "second Sources sample, so the row above cannot be satisfied by a filter that happens to "
    + "name one directory"],
  [`${SWIFT_PACKAGE_DIR}/Package.swift`, [IOS, MACOS, NWP, SWIFT_PACKAGE],
    "the manifest: products, targets and dependencies. Every Apple consumer resolves against it"],
  [`${SWIFT_PACKAGE_DIR}/Package.resolved`, [IOS, MACOS, NWP, SWIFT_PACKAGE],
    "the pinned dependency graph — a WebRTC or Sodium bump changes what every consumer links, "
    + "and it is exactly the change that compiles in one app and not the other"],
  [`${PACKAGE_TEST_DIR}/AeadTests.swift`, [SWIFT_PACKAGE],
    "an ORDINARY test, and the case this whole boundary exists for. It used to start two full "
    + "xcodebuild graphs, a simulator UI smoke, three acceptance runs and a 45-minute pairing "
    + "runner, none of which could observe it"],
  [`${PACKAGE_TEST_DIR}/IOSSurfaceGuardTests.swift`, [SWIFT_PACKAGE],
    "an iOS GUARD test — still an ordinary test file. `ios.yml` runs this class by `--filter` for "
    + "the other direction (an `apps/ios/**` change); editing the guard itself does not have to "
    + "start two xcodebuild graphs, because the unfiltered run here executes it with the rest"],
  [`${PACKAGE_FIXTURES_ROOT}/device-inbox-manifest-v3-vectors.json`, [GO, SWIFT_PACKAGE, WEB],
    "the one fixture with THREE implementations reading it. All three halves of the manifest "
    + "contract re-run on the bytes they agree about, and no heavy Apple or pairing lane starts"],
  [`${PACKAGE_FIXTURES_ROOT}/crypto-vectors.json`, [SWIFT_PACKAGE, WEB],
    "read by two Web suites and by the Swift one. NOT by any Go test, which is why `go.yml` does "
    + "not name it — the fixture paths are per-consumer, not a block copied between workflows"],
  [`${PACKAGE_FIXTURES_ROOT}/realtime-wire-vectors.json`, [SWIFT_PACKAGE, WEB],
    "the same two Web suites and the Swift one"],
  [`${PACKAGE_FIXTURES_ROOT}/store-wire-vectors.json`, [SWIFT_PACKAGE],
    "the fixture in that same directory that NO filtered workflow but the package's own reads. "
    + "This row is what makes `web.yml`'s three named entries mean something: a directory glob "
    + "there would start the full web suite for a file that suite never opens"],
  [`${PACKAGE_FIXTURES_ROOT}/account/me.json`, [SWIFT_PACKAGE],
    "a Swift-only fixture nested a directory deeper, so the exclusion is checked against "
    + "something a `Tests/Fixtures/*` glob would miss"],
  [`.github/workflows/${SWIFT_PACKAGE}`, [SWIFT_PACKAGE],
    "the lane's own definition: its filter must see edits to itself, and must not drag the three "
    + "heavy Apple lanes along"],
];

/**
 * Commits that touch more than one kind of file, and what each must still start.
 *
 * The isolation is about test-ONLY and fixture-ONLY changes. These rows are the
 * legitimate shapes it must NOT make cheaper, asserted so a later narrowing
 * cannot quietly turn the boundary into a source-change skip.
 */
const MIXED_DIFFS = [
  {
    what: "a shared-source change with its own test in the same commit",
    files: [
      `${SWIFT_PACKAGE_DIR}/Sources/RelayiumKit/Crypto/SealedBox.swift`,
      `${PACKAGE_TEST_DIR}/SealedBoxTests.swift`,
    ],
    want: [IOS, MACOS, NWP, SWIFT_PACKAGE].sort(),
    why: "one matching file is enough to start a workflow, so the source half still starts every "
      + "Apple consumer. A test written beside a source change must never make that change "
      + "cheaper to merge",
  },
  {
    what: "a test-only change plus a fixture two other languages read",
    files: [
      `${PACKAGE_TEST_DIR}/InboxManifestTests.swift`,
      `${PACKAGE_FIXTURES_ROOT}/device-inbox-manifest-v3-vectors.json`,
    ],
    want: [GO, SWIFT_PACKAGE, WEB].sort(),
    why: "no Apple or pairing lane reads either file, and the two cross-language consumers of "
      + "that fixture do",
  },
  {
    what: "a macOS app change with a shared-package test in the same commit",
    files: ["apps/mac/Relayium/AccountView.swift", `${PACKAGE_TEST_DIR}/AeadTests.swift`],
    want: [MACOS, SWIFT_PACKAGE].sort(),
    why: "the app file starts its own owner and the test file starts the package lane; neither "
      + "reaches iOS or the pairing acceptance",
  },
];

// ── a parser for the YAML subset these workflows use ────────────────────────
//
// Deliberately a second copy rather than an import from
// `ci-event-policy-test.mjs`. These guards run independently and each is meant
// to be readable on its own; a shared helper would also let one parser bug make
// both agree with each other about a workflow neither had actually read.

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
      && a.length === b.length && a.every((v, k) => deepEqual(v, b[k]));
  }
  if (a && b && typeof a === "object" && typeof b === "object") {
    const ka = Object.keys(a);
    const kb = Object.keys(b);
    return ka.length === kb.length && ka.every((k) => deepEqual(a[k], b[k]));
  }
  return false;
}

/**
 * Every construct this file depends on, parsed and compared against the exact
 * object it must produce.
 *
 * A hand-written parser is the one thing here that could make every rule below
 * pass vacuously: mis-read a workflow, get `undefined` where a rule expected a
 * value, and the rules are testing the parser's failure rather than the
 * boundary. Each line corresponds to something real — `&paths` is the anchor
 * every governed workflow still declares on its one remaining filtered event,
 * the `*paths` alias is kept because the parser must not regress on a construct
 * these files carried until the merge gate replaced their `pull_request:`
 * trigger, the bare `workflow_call:` is that replacement and is what section 1b
 * asks about by presence, the `!` entry is the exclusion this whole file is
 * about, `run: |` is every shell step, and `on:` is the key YAML 1.1 would
 * otherwise turn into the boolean `true` and hide from everything below.
 *
 * The bare-key case earns its line twice over: `workflow_call:` has no value and
 * is followed by a SHALLOWER key, so a parser that descended into it would
 * swallow `jobs:` whole and every rule below would read a workflow with no jobs
 * in it.
 */
function assertParserReadsTheWorkflowSubset() {
  const fixture = [
    "name: sample",
    "on:",
    "  push:",
    "    branches:",
    "      - main",
    "    paths: &paths",
    "      - 'apps/RelayiumKit/**'",
    "      # a comment between entries",
    "      - '!apps/RelayiumKit/Tests/**'",
    "  pull_request:",
    "    paths: *paths",
    "  workflow_call:",
    "  workflow_dispatch:",
    "jobs:",
    "  swift-test:",
    "    runs-on: macos-15",
    "    timeout-minutes: 25",
    "    steps:",
    "      - uses: actions/checkout@abc123",
    "      - name: swift test",
    "        working-directory: apps/RelayiumKit",
    "        run: |",
    "          swift test",
    "",
  ].join("\n");
  const want = {
    name: "sample",
    on: {
      push: {
        branches: ["main"],
        paths: ["apps/RelayiumKit/**", "!apps/RelayiumKit/Tests/**"],
      },
      pull_request: { paths: ["apps/RelayiumKit/**", "!apps/RelayiumKit/Tests/**"] },
      workflow_call: null,
      workflow_dispatch: null,
    },
    jobs: {
      "swift-test": {
        "runs-on": "macos-15",
        "timeout-minutes": "25",
        steps: [
          { uses: "actions/checkout@abc123" },
          {
            name: "swift test",
            "working-directory": "apps/RelayiumKit",
            run: "swift test\n",
          },
        ],
      },
    },
  };
  let got;
  try {
    got = parseYaml(fixture);
  } catch (err) {
    check(false, `the embedded parser fixture did not parse: ${err.message}`);
    return;
  }
  check(
    deepEqual(got, want),
    `the YAML parser produced ${JSON.stringify(got)} for its own fixture; want `
    + `${JSON.stringify(want)}. Every rule in this file reads the parser's output, so a parser `
    + `that mis-reads a workflow would make all of them pass while asserting nothing.`,
  );
  // The `on:` key specifically, because YAML 1.1 turns it into the boolean
  // `true` and a parser that did would hide every trigger from every rule here.
  check(
    Object.prototype.hasOwnProperty.call(got ?? {}, "on"),
    `the parser did not keep \`on:\` as the string key "on" (keys: `
    + `${JSON.stringify(Object.keys(got ?? {}))}). Under YAML 1.1 it becomes \`true\`, and every `
    + `path filter below would then be unreachable.`,
  );
}

assertParserReadsTheWorkflowSubset();

// ── load the workflows ──────────────────────────────────────────────────────

/** Every workflow file on disk, verbatim and with whole-line comments removed. */
const stripComments = (text) => text.split("\n").filter((line) => !/^\s*#/.test(line)).join("\n");
const workflowTexts = new Map(
  readdirSync(workflowsDir)
    .filter((name) => /\.ya?ml$/.test(name))
    .map((name) => [name, stripComments(readFileSync(resolve(workflowsDir, name), "utf8"))]),
);

const docs = new Map();
// `PARSED` plus the unfiltered aggregate gate. The gate is not part of the
// closed filtered set section 1a checks, but sections 1b and 5 read it, and a
// gate that vanished or stopped parsing must fail by name rather than leave
// every reachability rule reasoning about `undefined`.
for (const file of [...PARSED, AGGREGATE]) {
  const text = workflowTexts.get(file);
  if (text === undefined) {
    check(
      false,
      `${file} is not in .github/workflows/, but this boundary reasons about it by name. A `
      + `workflow that vanished takes its half of the ownership rules with it, and every `
      + `remaining rule would still report green.`,
    );
    continue;
  }
  try {
    docs.set(file, parseYaml(text));
  } catch (err) {
    check(false, `${file} did not parse: ${err.message}`);
  }
}

/**
 * A parse that silently produced an empty document must not read as a pass.
 *
 * The rules below are mostly of the form "this list does not contain X" and
 * "this job declares no Y", and an empty object satisfies almost all of them.
 */
for (const [file, doc] of docs) {
  check(
    doc && typeof doc === "object" && doc.on && Object.keys(doc.jobs ?? {}).length > 0,
    `${file} parsed to a document with no \`on:\` or no jobs (${JSON.stringify(doc)}). Every rule `
    + `below reads those two keys, so this would be a green run over a workflow nobody read.`,
  );
}

/**
 * The filtered workflows actually on disk, derived rather than listed.
 *
 * `PARSED` is the list this file reasons about; this is what the repository
 * really has. Comparing them is what makes "no workflow but `swift-package.yml`
 * starts on an ordinary Swift test" a closed claim: a NEW path-filtered workflow
 * that nobody added here would otherwise be free to name the package's test
 * target, and every rule below would still pass.
 */
const filteredOnDisk = [...workflowTexts.keys()]
  .filter((file) => /^\s*paths:/m.test(workflowTexts.get(file) ?? ""))
  .sort();

// ── the filter compiler: ordered, last match wins ───────────────────────────

/**
 * A GitHub path filter compiled to a regular expression: `**` crosses `/`, a
 * single `*` does not, and every regex metacharacter is escaped so a literal
 * dot cannot match an arbitrary character.
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
 * ORDERED, LAST MATCH WINS — not `some()`. Under an unordered reading every
 * file under `apps/RelayiumKit/Tests/` still reads as triggering, because the
 * positive `apps/RelayiumKit/**` matches it, and the whole boundary this file
 * exists for would be asserted by nothing while every check reported green. The
 * ordering is also what makes "the negation was moved above the positive it
 * qualifies" detectable at all: under `some()` the two orders are
 * indistinguishable.
 */
function matchesFilter(patterns, path) {
  let matched = false;
  for (const pattern of patterns ?? []) {
    if (!pathFilterToRegExp(filterBody(pattern)).test(path)) continue;
    matched = !isNegation(pattern);
  }
  return matched;
}

/** The positive (non-`!`) entries of a filter. */
const positivePatterns = (paths) => (paths ?? []).filter((pattern) => !isNegation(pattern));

// ── the world every rule reads ──────────────────────────────────────────────

/**
 * The fixtures named above that really exist on disk.
 *
 * Read rather than assumed. A filter naming a fixture that has been renamed or
 * deleted is not a narrower filter, it is an entry that can never match — and
 * the suite it was meant to start would quietly stop starting for the file that
 * replaced it, which is exactly the gate-that-cannot-fail this file rejects.
 */
const fixtureFiles = (() => {
  const named = [
    ...FIXTURE_INPUTS.map((entry) => entry.fixture),
    ...FIXTURE_NON_INPUTS.map((entry) => entry.fixture),
  ];
  return new Set(named.filter((path) => {
    try {
      readFileSync(resolve(repoRoot, path));
      return true;
    } catch {
      return false;
    }
  }));
})();

/**
 * The source of every test that reads one of those fixtures, keyed by path.
 *
 * This is what makes the fixture rules non-vacuous in the direction that
 * actually decays. Asserting only that `web.yml` lists three paths proves the
 * YAML says so; it proves nothing about whether anything still opens them.
 *
 * A missing file is recorded as `null` rather than as an empty string: an empty
 * string satisfies no `includes()`, which would report the same complaint as a
 * consumer that merely stopped reading its fixture, and those are different
 * repairs.
 */
const fixtureConsumerTexts = (() => {
  const out = new Map();
  for (const { consumers } of FIXTURE_INPUTS) {
    for (const { file } of consumers) {
      if (out.has(file)) continue;
      try {
        out.set(file, readFileSync(resolve(repoRoot, file), "utf8"));
      } catch {
        out.set(file, null);
      }
    }
  }
  return out;
})();

/**
 * A fresh copy of everything the rules read.
 *
 * The rules take a world and RETURN their complaints rather than pushing them,
 * which is the whole design: section 6 hands them a broken copy of the real
 * workflows and requires the matching wording, so a rule that can no longer
 * fail is itself a failure.
 */
function world() {
  return {
    docs: new Map([...docs].map(([file, doc]) => [file, structuredClone(doc)])),
    texts: new Map(workflowTexts),
    filtered: [...filteredOnDisk],
    fixtures: new Set(fixtureFiles),
    fixtureConsumers: new Map(fixtureConsumerTexts),
  };
}

/** The `push` path filter of a workflow, or null when it has none. */
const wPaths = (w, file) => {
  const push = w.docs.get(file)?.on?.push;
  const paths = push && typeof push === "object" ? push.paths : undefined;
  return Array.isArray(paths) ? paths : null;
};

/**
 * The run lines of a job that are actual work.
 *
 * A placeholder job is syntactically a job: it has a runner, a timeout and a
 * step. What it does not have is a command, and `echo`/`true`/`exit 0` is how
 * one is written.
 */
function realRunLines(job) {
  return (job?.steps ?? [])
    .flatMap((step) => String(step?.run ?? "").split("\n"))
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"))
    .filter((line) => !/^(echo\b|printf\b|true$|:$|exit 0$|set\s+-|shopt\b)/.test(line));
}

/** The `--filter` selectors of a `swift test` command line, in order. */
function swiftTestFilters(run) {
  const out = [];
  const re = /--filter[=\s]+(?:'([^']*)'|"([^"]*)"|(\S+))/g;
  for (const m of String(run).matchAll(re)) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}

/** Every step in a world that runs `swift test`, with where it runs and how. */
function swiftTestSteps(w) {
  const out = [];
  for (const [file, doc] of w.docs) {
    for (const [jobName, job] of Object.entries(doc?.jobs ?? {})) {
      for (const step of job?.steps ?? []) {
        const run = String(step?.run ?? "");
        if (!/\bswift\s+test\b/.test(run)) continue;
        out.push({ file, jobName, step, run, filters: swiftTestFilters(run) });
      }
    }
  }
  return out;
}

// ── 1. the lane exists, and is the only unfiltered `swift test` ─────────────

function laneFailures(w) {
  const out = [];
  const need = (ok, message) => { if (!ok) out.push(message); };

  const doc = w.docs.get(SWIFT_PACKAGE);
  need(
    doc !== undefined,
    `${SWIFT_PACKAGE} is missing or did not parse. It is the sole owner of the repository's `
    + `unfiltered \`swift test\`, and three heavy Apple/pairing filters exclude `
    + `\`${PACKAGE_TESTS_GLOB}\` ONLY because it covers that subtree. Without it the package's own `
    + `suite runs nowhere while every board stays green.`,
  );

  // 1a. The list this file reasons about still matches the repository. A NEW
  //     filtered workflow is free to name the package's test target, and every
  //     rule below is a statement about a closed set.
  const unknown = w.filtered.filter((file) => !PARSED.includes(file));
  need(
    unknown.length === 0,
    `[${unknown.join(", ")}] declare a \`paths:\` filter but are not in this file's PARSED list, `
    + `so nothing here judges what they start. Every ownership rule below is a claim about ALL `
    + `filtered workflows — "an ordinary Swift test starts ${SWIFT_PACKAGE} and nothing else" is `
    + `not checkable against a set that has grown behind its back. Add the workflow here and `
    + `decide, in its filter, what it owns.`,
  );

  if (doc) {
    // 1b. Its filter: the whole package, its own file, and nothing else.
    const paths = wPaths(w, SWIFT_PACKAGE);
    need(
      paths !== null,
      `${SWIFT_PACKAGE} has no push path filter, so it runs on every change to the repository — a `
      + `PAID macOS runner on documentation, server and web commits alike.`,
    );
    if (paths !== null) {
      need(
        deepEqual(paths, [PACKAGE_SOURCE_GLOB, `.github/workflows/${SWIFT_PACKAGE}`]),
        `${SWIFT_PACKAGE}'s path filter is ${JSON.stringify(paths)}; want exactly `
        + `["${PACKAGE_SOURCE_GLOB}", ".github/workflows/${SWIFT_PACKAGE}"]. It tests one package `
        + `and nothing else: a wider entry charges a macOS runner for a tree it does not compile, `
        + `and ANY exclusion under \`${SWIFT_PACKAGE_DIR}\` is the failure this workflow was `
        + `created to prevent — three heavy filters exclude the test target on the strength of `
        + `this one covering it.`,
      );
      need(
        !paths.some(isNegation),
        `${SWIFT_PACKAGE}'s path filter carries an exclusion `
        + `(${JSON.stringify(paths.filter(isNegation))}). This is the workflow that must see EVERY `
        + `file in the package — Sources, Tests, Fixtures, \`Package.swift\` and `
        + `\`Package.resolved\` — because it is the only one that still does. An exclusion here `
        + `creates a file with no owner at all.`,
      );
      // The filter above is now the lane's ONLY filtered event. There used to
      // be a second, aliased copy under `pull_request:` and a rule comparing
      // the two; both went with that trigger. What the comparison protected — a
      // filter narrower on one event than the other — cannot exist with one
      // filtered event left, and pull-request coverage is asserted immediately
      // below against the gate that actually provides it.
    }

    // 1b′. The package suite is still reachable from a pull request, PROVED
    //      against `merge-gate.yml` rather than assumed.
    //
    //      `push` here is restricted to `main`, so on a branch this lane is
    //      reached exclusively by the gate calling it. That is a better
    //      arrangement than the aliased filter it replaced — one always-present
    //      required context instead of eight sometimes-present ones — and it is
    //      also a new way to lose the package suite silently, in three shapes
    //      that each leave every file valid and actionlint happy:
    //
    //        * the lane drops `workflow_call:`, so the gate's `uses:` cannot
    //          resolve. That fails the WHOLE gate run to LOAD, so the required
    //          context reports nothing and the merge box shows a MISSING check
    //          rather than a red one;
    //        * the gate stops calling the lane. Both files are fine, and every
    //          file in the package — the subtree three heavy filters exclude on
    //          the strength of this lane covering it — is judged by nothing
    //          until the merge has already landed;
    //        * the gate itself grows a `pull_request` path filter, which is the
    //          absent-check failure re-created one level up, for every lane.
    const on = doc.on && typeof doc.on === "object" ? doc.on : {};
    const declares = (key) => Object.prototype.hasOwnProperty.call(on, key);
    need(
      declares("workflow_call"),
      `${SWIFT_PACKAGE} declares no \`workflow_call:\`, so ${AGGREGATE}'s \`uses:\` cannot `
      + `resolve it. This does not merely skip the package suite: GitHub fails the entire gate run `
      + `to LOAD, the one required context never reports, and the merge box shows a missing check `
      + `instead of a red one — over a pull request nothing in the package was compiled for.`,
    );
    need(
      !declares("pull_request"),
      `${SWIFT_PACKAGE} declares its own \`pull_request\` trigger again. ${AGGREGATE} already `
      + `calls it, so every commit on a branch with an open pull request runs the package suite `
      + `TWICE — once directly, once through the gate — which is two PAID macOS runners for one `
      + `answer, the exact duplication this boundary was created to remove.`,
    );

    const gate = w.docs.get(AGGREGATE);
    need(
      gate !== undefined,
      `${AGGREGATE} is missing or did not parse, and it is the ONLY way a pull request now reaches `
      + `${SWIFT_PACKAGE}. Without it the sole owner of the repository's unfiltered \`swift test\` `
      + `runs on \`main\` and nowhere else, while three heavy filters keep excluding the subtree `
      + `on the strength of it.`,
    );
    if (gate !== undefined) {
      const gateOn = gate.on && typeof gate.on === "object" ? gate.on : {};
      const gatePr = gateOn.pull_request;
      const gatePrPaths = gatePr !== null && typeof gatePr === "object" ? (gatePr.paths ?? null) : null;
      need(
        Object.prototype.hasOwnProperty.call(gateOn, "pull_request"),
        `${AGGREGATE} declares no \`pull_request\` trigger (its \`on:\` is `
        + `${JSON.stringify(Object.keys(gateOn))}); it is the pull-request entry point every lane `
        + `here gave up its own trigger for.`,
      );
      need(
        gatePrPaths === null,
        `${AGGREGATE}'s \`pull_request\` trigger has grown a path filter `
        + `(${JSON.stringify(gatePrPaths)}). The gate is the one workflow that must start on EVERY `
        + `pull request: a filtered gate emits no check run for what it skips, which is the `
        + `absent-required-context failure the lanes were converted to avoid.`,
      );

      const callers = Object.entries(gate.jobs ?? {})
        .filter(([, job]) => job?.uses === `./.github/workflows/${SWIFT_PACKAGE}`)
        .map(([name]) => name)
        .sort();
      need(
        callers.length === 1,
        `${AGGREGATE} declares ${callers.length} job(s) [${callers.join(", ")}] with `
        + `\`uses: ./.github/workflows/${SWIFT_PACKAGE}\`; want exactly one. Zero is a package `
        + `suite no pull request reaches at all now that its own trigger is gone — an ordinary `
        + `Swift test edit would start NO workflow on a branch, which is the zero-owner state this `
        + `file's whole ownership matrix exists to reject. Two is two PAID macOS runners.`,
      );
      need(
        callers.length !== 1 || callers[0] === SWIFT_PACKAGE_GATE_JOB,
        `${AGGREGATE} calls ${SWIFT_PACKAGE} from job "${callers[0]}"; want `
        + `"${SWIFT_PACKAGE_GATE_JOB}". The caller job id is the check-run prefix and the key the `
        + `gate's own selector output and \`needs:\` roster are matched by name against.`,
      );
    }

    // 1c. ONE job, and it is fail-closed, secret-free, unsigned and finite.
    //
    //     The heavy lanes sign, notarize and publish; this one compiles a
    //     package and runs its tests, so a secret, an artifact upload or an
    //     installer step here is either dead weight on a PAID runner or a
    //     release path growing in the cheapest workflow to edit.
    const text = w.texts.get(SWIFT_PACKAGE) ?? "";
    for (const [pattern, what] of [
      [/secrets\./, "reads a repository secret"],
      [/upload-artifact|download-artifact/, "uploads or downloads a build artifact"],
      [/\bbrew\s+install\b|\bnpm\s+(ci|install)\b|setup-node|setup-go/,
        "installs a toolchain or dependency tree"],
      [/codesign|notarytool|productsign|xcrun\s+altool|softwareupdate/,
        "signs, notarizes or mutates the runner's system state"],
      [/\bretry\b|\bretries\b/i, "retries"],
    ]) {
      need(
        !pattern.test(text),
        `${SWIFT_PACKAGE} ${what} (matched ${pattern}). This workflow exists to run one `
        + `\`swift test\` on a checkout: it has no signing identity, no artifact to publish and `
        + `nothing intermittent for a retry to smooth over. Anything in that list is either a `
        + `release path growing in the cheapest workflow to edit, or dead weight on a PAID macOS `
        + `runner charged on every package commit.`,
      );
    }
    const jobNames = Object.keys(doc.jobs ?? {});
    need(
      deepEqual(jobNames, [SWIFT_PACKAGE_JOB]),
      `${SWIFT_PACKAGE} declares jobs [${jobNames.join(", ")}]; want exactly `
      + `["${SWIFT_PACKAGE_JOB}"]. One package, one suite, one PAID macOS runner: a second job `
      + `here is a second macOS charge per package commit, and it is a decision that has to be `
      + `made deliberately — including in \`RUNNER_BUDGETS\` in `
      + `\`scripts/test/ci-event-policy-test.mjs\`, which is where the ceiling lives.`,
    );
    for (const [name, job] of Object.entries(doc.jobs ?? {})) {
      need(
        job.if === undefined,
        `${SWIFT_PACKAGE}/${name}: a job-level "if:" lets the package suite skip itself, and a `
        + `skipped check reports NOTHING rather than red. This job reads no secrets, so it runs on `
        + `fork pull requests and has no condition to be under.`,
      );
      need(
        job["continue-on-error"] === undefined,
        `${SWIFT_PACKAGE}/${name}: continue-on-error makes the only run of the shared package's `
        + `suite advisory.`,
      );
      need(
        realRunLines(job).length > 0,
        `${SWIFT_PACKAGE}/${name}: has no real run step — every run line is an \`echo\` or a `
        + `no-op. A placeholder here reports a green Swift check for a package nobody tested, `
        + `while three heavy filters exclude the test target on the strength of it.`,
      );
      const timeout = Number(job["timeout-minutes"]);
      need(
        Number.isFinite(timeout) && timeout > 0,
        `${SWIFT_PACKAGE}/${name}: timeout-minutes is `
        + `${JSON.stringify(job["timeout-minutes"])}, want a finite positive number. Undeclared, `
        + `this job inherits GitHub's SIX-HOUR default on a PAID macOS runner, so one `
        + `\`swift test\` that never exits costs six hours instead of turning the board red in `
        + `minutes. The CEILING is declared once, in \`RUNNER_BUDGETS\` in `
        + `\`scripts/test/ci-event-policy-test.mjs\`; this rule is only that a number exists.`,
      );
      for (const step of job.steps ?? []) {
        need(
          step.if === undefined,
          `${SWIFT_PACKAGE}/${name}: a step sets "if:", and a suite that can skip itself is not a `
          + `suite.`,
        );
        need(
          step["continue-on-error"] === undefined,
          `${SWIFT_PACKAGE}/${name}: a step sets continue-on-error, which lets the job report `
          + `green after the package's tests failed.`,
        );
      }
      const swallows = realRunLines(job).find((line) => /\|\|\s*(true|:|echo|exit 0)/.test(line));
      need(
        swallows === undefined,
        `${SWIFT_PACKAGE}/${name}: a command swallows its own exit status `
        + `(${JSON.stringify(swallows ?? "")}), so the suite reports green after failing.`,
      );
    }
  }

  // 1d. Exactly ONE unfiltered `swift test`, and it is this job.
  //
  //     Zero leaves every Swift assertion in the package unexecuted while
  //     `ios.yml`'s five narrow guard selectors keep the board green. Two is the
  //     same suite on two PAID macOS runners per commit for one answer — and,
  //     historically, one of the two sitting behind a signing workflow's filter.
  const unfiltered = swiftTestSteps(w).filter((entry) => entry.filters.length === 0);
  need(
    unfiltered.length === 1,
    `${unfiltered.length} unfiltered \`swift test\` step(s) exist across the parsed workflows `
    + `(${unfiltered.map((e) => `${e.file}/${e.jobName}`).join(", ") || "none"}); want exactly `
    + `one. Zero leaves the shared package's ${SWIFT_TEST_TARGET} suite unexecuted everywhere — `
    + `${IOS}'s \`--filter\` selectors are not a substitute and were never meant to be. Two `
    + `charges a PAID macOS runner twice for one answer.`,
  );
  for (const entry of unfiltered) {
    need(
      entry.file === SWIFT_PACKAGE && entry.jobName === SWIFT_PACKAGE_JOB,
      `the unfiltered \`swift test\` runs in ${entry.file}/${entry.jobName}; want `
      + `${SWIFT_PACKAGE}/${SWIFT_PACKAGE_JOB}. Anywhere else it is reachable only through that `
      + `workflow's path filter, which is how the package's own suite ended up requiring the macOS `
      + `signing lane to start — and why three heavy filters had to carry `
      + `\`${PACKAGE_TESTS_GLOB}\` at all.`,
    );
    need(
      entry.step["working-directory"] === SWIFT_PACKAGE_DIR,
      `the unfiltered \`swift test\` declares working-directory `
      + `${JSON.stringify(entry.step["working-directory"])}, want `
      + `${JSON.stringify(SWIFT_PACKAGE_DIR)}. \`swift test\` resolves its package from the `
      + `working directory; anywhere else it either fails or tests a different package.`,
    );
  }
  // And the same fact read from the FILES rather than from the parsed subset, so
  // a `swift test` in a workflow this policy does not parse cannot hide from the
  // count above.
  const hosts = [...w.texts]
    .filter(([, text]) => /\bswift\s+test\b/.test(text))
    .map(([file]) => file)
    .sort();
  const wantHosts = [CONTRACTS, IOS, SWIFT_PACKAGE].sort();
  need(
    deepEqual(hosts, wantHosts),
    `\`swift test\` appears in [${hosts.join(", ")}]; want exactly `
    + `[${wantHosts.join(", ")}]. Read from every workflow file on disk rather `
    + `than from the parsed subset, because a workflow this policy does not parse can run `
    + `\`swift test\` just as well as one it does — and a FOURTH host is another PAID macOS runner `
    + `nobody costed. ${IOS} is expected: it runs named \`--filter\` selectors over `
    + `\`apps/ios\` guards for the other direction, an \`apps/ios/**\` change. ${CONTRACTS} is `
    + `expected: it runs the Swift half of the root contract tree, always filtered — see 1f.`,
  );

  // 1f. The contract lane's `swift test` is FILTERED, and to exactly one class.
  //
  //     1d already refuses a second UNFILTERED `swift test` wherever it appears,
  //     so this is the other half: a filtered one whose selector grows. The
  //     lane is justified by being the smallest command that judges the Swift
  //     half of a document; a selector naming the target, a suffix, or a second
  //     class is a second package suite arriving one argument at a time, on a
  //     PAID runner, started by every contract edit.
  const contractSteps = swiftTestSteps(w).filter((entry) => entry.file === CONTRACTS);
  need(
    contractSteps.length === 1,
    `${CONTRACTS} runs ${contractSteps.length} \`swift test\` step(s); want exactly one. This lane `
    + `exists to run the smallest command that judges one document against one test class.`,
  );
  for (const entry of contractSteps) {
    need(
      entry.jobName === CONTRACTS_SWIFT_JOB,
      `${CONTRACTS}'s \`swift test\` runs in job ${entry.jobName}; want `
      + `${CONTRACTS_SWIFT_JOB}, which is the job this policy and `
      + `\`scripts/test/contract-ci-policy-test.mjs\` both name.`,
    );
    need(
      deepEqual(entry.filters, [CONTRACTS_SWIFT_FILTER]),
      `${CONTRACTS}'s \`swift test\` selects ${JSON.stringify(entry.filters)}; want exactly `
      + `["${CONTRACTS_SWIFT_FILTER}"]. Zero filters would run the WHOLE package suite on a `
      + `document edit and duplicate ${SWIFT_PACKAGE} on a PAID runner; a wider or additional `
      + `selector is that same suite arriving one argument at a time.`,
    );
    need(
      entry.step["working-directory"] === SWIFT_PACKAGE_DIR,
      `${CONTRACTS}'s \`swift test\` declares working-directory `
      + `${JSON.stringify(entry.step["working-directory"])}, want `
      + `${JSON.stringify(SWIFT_PACKAGE_DIR)}. \`swift test\` resolves its package from the `
      + `working directory; anywhere else it either fails or tests a different package.`,
    );
  }

  // 1g. The contract lane must not reach into the package's own tree.
  //
  //     It watches exactly one document in `contracts/` — the tree's ownership
  //     is per file since `ops-deploy-contract.yml` joined it. The moment its
  //     filter also names a package path, an ordinary Swift edit starts BOTH
  //     macOS lanes for one answer — the exact duplication this file was
  //     created to remove.
  const contractPaths = wPaths(w, CONTRACTS);
  need(
    contractPaths === null || !contractPaths.some((p) => String(p).includes(SWIFT_PACKAGE_DIR)),
    `${CONTRACTS}'s path filter names \`${SWIFT_PACKAGE_DIR}\` `
    + `(${JSON.stringify(contractPaths)}). An ordinary package edit would then start this PAID `
    + `macOS lane as well as ${SWIFT_PACKAGE}'s, and ${SWIFT_PACKAGE} already runs this test `
    + `class as part of its unfiltered suite.`,
  );

  return out;
}

// ── 2. the ordered negation in each heavy consumer ──────────────────────────

function negationFailures(w) {
  const out = [];
  const need = (ok, message) => { if (!ok) out.push(message); };

  // 2a. A filter of nothing but `!` entries matches no file at all under
  //     last-match-wins, so its workflow never runs. Valid YAML, happy
  //     actionlint, and a board that shows no check rather than a red one.
  for (const file of w.filtered) {
    const paths = wPaths(w, file);
    if (paths === null) continue;
    need(
      positivePatterns(paths).length > 0,
      `${file}'s path filter has no positive pattern — it is ${JSON.stringify(paths)}, all `
      + `exclusions. GitHub evaluates a filter per file with the last match winning, so a list of `
      + `nothing but \`!\` entries matches nothing and this workflow never runs on push or on a `
      + `pull request. That is not a stricter gate; it is an absent one, and an absent check `
      + `reports nothing rather than red.`,
    );
  }

  // 2b. The negation, stated three ways: present, positioned, and effective.
  for (const file of HEAVY_CONSUMERS) {
    const paths = wPaths(w, file);
    if (paths === null) {
      need(
        !w.docs.has(file),
        `${file} lost its path filter entirely, so it now runs on every change in the repository — `
        + `including the package test-only edits this boundary exists to keep off a PAID macOS `
        + `runner.`,
      );
      continue;
    }
    const sourceAt = paths.indexOf(PACKAGE_SOURCE_GLOB);
    const negationAt = paths.indexOf(PACKAGE_TESTS_NEGATION);
    need(
      negationAt !== -1,
      `${file}'s path filter does not list \`${PACKAGE_TESTS_NEGATION}\`; it lists `
      + `${JSON.stringify(paths)}. Without it every edit under \`${PACKAGE_TESTS_ROOT}\` starts `
      + `this workflow again, and this workflow cannot observe one: \`xcodebuild\` compiles the `
      + `package's library products and never its test target, no release script opens a file in `
      + `it, and \`swift build --product LocalTransferPeer\` does not build it either. `
      + `${SWIFT_PACKAGE} is what runs those files.`,
    );
    need(
      sourceAt !== -1,
      `${file}'s path filter no longer lists the positive \`${PACKAGE_SOURCE_GLOB}\`. The `
      + `exclusion below it then qualifies nothing, and a change to the shared package's SOURCE — `
      + `which this workflow does compile — stops starting it.`,
    );
    need(
      sourceAt === -1 || negationAt === -1 || negationAt > sourceAt,
      `${file} lists \`${PACKAGE_TESTS_NEGATION}\` at position ${negationAt + 1}, BEFORE `
      + `\`${PACKAGE_SOURCE_GLOB}\` at position ${sourceAt + 1}. GitHub applies a \`paths:\` list `
      + `per changed file in order and the LAST match wins, so in that order the exclusion is `
      + `overridden by the very pattern it qualifies and does nothing at all. The YAML is valid, `
      + `actionlint is happy, the diff reads as a reordering, and every run this entry removes `
      + `comes back.`,
    );
  }

  // 2c. The globs that would reach the excluded subtree by re-including it,
  //     rejected literally in every filtered workflow but the package's own.
  //     The behavioural rules in section 3 catch this too; the literal form is
  //     what a reader greps for, and it names the specific edit.
  for (const file of w.filtered) {
    if (file === SWIFT_PACKAGE) continue;
    const paths = wPaths(w, file);
    if (paths === null) continue;
    for (const glob of FIXTURE_TREE_GLOBS) {
      need(
        !paths.includes(glob),
        `${file}'s path filter lists \`${glob}\`, which re-includes the shared package's test `
        + `target — or the whole of its fixture directory — after any exclusion above it. `
        + `Whatever this workflow reads, it does not read all of that: name the individual fixture `
        + `paths its own tests open, the way ${GO} and ${WEB} do.`,
      );
    }
  }

  return out;
}

// ── 3. ownership, as compiled behaviour, in both directions ─────────────────

function ownershipFailures(w) {
  const out = [];
  const need = (ok, message) => { if (!ok) out.push(message); };
  const starters = (path) => w.filtered
    .filter((file) => matchesFilter(wPaths(w, file), path))
    .sort();

  for (const [sample, want, why] of OWNERSHIP) {
    const got = starters(sample);
    need(
      got.length > 0,
      `"${sample}" starts NO path-filtered workflow. It is a file in the shared Swift package, so `
      + `it is an input to \`swift test\` whatever else it is; with no owner it can only be broken `
      + `and discovered later, against a commit that did not break it. ${SWIFT_PACKAGE} is what `
      + `must own it — ${why}.`,
    );
    need(
      deepEqual(got, [...want].sort()),
      `a change to "${sample}" starts [${got.join(", ")}]; want [${[...want].sort().join(", ")}] `
      + `— ${why}. Judged by compiling each \`paths:\` list and evaluating it the way GitHub does `
      + `(ordered, last match wins), not by list membership: a filter carrying a negation reports `
      + `the same membership answer for a source file and for a test file. Too broad and too `
      + `narrow fail here the same way, because a missing run and a surplus run are one decision `
      + `made in opposite directions.`,
    );
  }

  // The negative half, stated separately from the exact sets above so it
  // survives a future fourth heavy consumer that nobody adds to OWNERSHIP.
  for (const sample of [
    `${PACKAGE_TEST_DIR}/AeadTests.swift`,
    `${PACKAGE_TEST_DIR}/RealtimeSenderTests.swift`,
  ]) {
    const heavy = starters(sample).filter((file) => file !== SWIFT_PACKAGE);
    need(
      heavy.length === 0,
      `an ordinary test in the shared package ("${sample}") starts [${heavy.join(", ")}] besides `
      + `${SWIFT_PACKAGE}. No product build, release script or acceptance run reads the package's `
      + `test target, so every one of those is a runner charged for evidence it cannot produce — `
      + `and on a macOS lane, a PAID one.`,
    );
  }

  // Mixed diffs: the legitimate shapes this boundary must NOT make cheaper.
  for (const { what, files, want, why } of MIXED_DIFFS) {
    const got = w.filtered
      .filter((file) => files.some((changed) => matchesFilter(wPaths(w, file), changed)))
      .sort();
    need(
      deepEqual(got, want),
      `${what} (${files.join(" + ")}) starts [${got.join(", ")}]; want [${want.join(", ")}] — `
      + `${why}.`,
    );
  }

  return out;
}

// ── 4. the fixtures, per consumer, against the consuming source ─────────────

function fixtureFailures(w) {
  const out = [];
  const need = (ok, message) => { if (!ok) out.push(message); };

  for (const { fixture, consumers } of FIXTURE_INPUTS) {
    need(
      w.fixtures.has(fixture),
      `the fixture "${fixture}" does not exist on disk, but ${consumers.length} workflow filter `
      + `entr${consumers.length === 1 ? "y names" : "ies name"} it. A filter entry that can never `
      + `match is not a narrower filter — it is a suite that silently stopped starting for the `
      + `file that replaced this one.`,
    );
    const basename = fixture.split("/").pop();
    for (const { file, workflow, what } of consumers) {
      const text = w.fixtureConsumers.get(file);
      need(
        text !== null && text !== undefined,
        `the fixture consumer "${file}" could not be read, so nothing below can say whether `
        + `"${fixture}" is still an input to ${workflow}. It is named in FIXTURE_INPUTS; if the `
        + `test moved, follow it there rather than letting the check inspect nothing.`,
      );
      need(
        typeof text !== "string" || text.includes(basename),
        `"${file}" no longer names "${basename}" (${what}), but ${workflow}'s path filter still `
        + `lists "${fixture}". Either the consumer moved to a different fixture — in which case `
        + `half of a cross-language contract now lands unchecked and the filter has to follow it — `
        + `or the read is gone and the filter is charging a full suite for a file nothing opens.`,
      );
      const paths = wPaths(w, workflow);
      need(
        paths !== null && paths.includes(fixture),
        `${workflow}'s path filter does not list "${fixture}" verbatim; it lists `
        + `${JSON.stringify(paths)}. "${file}" reads that file from disk and asserts ${what} still `
        + `agrees with the frozen bytes, so it is an input to that suite exactly like a source `
        + `file. Named ONE PATH AT A TIME on purpose: the fixture lives inside a test target three `
        + `other workflows deliberately exclude, and a directory glob here would start this whole `
        + `suite for every Swift test edit.`,
      );
      // Only when the entry IS present, so this reports the case it is for — a
      // listed path the compiled filter nevertheless does not match — instead of
      // restating the missing-entry complaint above with a cause that is not the
      // cause.
      need(
        paths === null || !paths.includes(fixture) || matchesFilter(paths, fixture),
        `${workflow} lists "${fixture}" but does not actually trigger on it once the filter is `
        + `compiled with last-match-wins semantics. A later entry is excluding it, so the line is `
        + `present, the diff looks right, and the suite that judges those bytes still would not run `
        + `on the commit that changed them.`,
      );
    }
  }

  for (const { fixture, why } of FIXTURE_NON_INPUTS) {
    need(
      w.fixtures.has(fixture),
      `the fixture "${fixture}" does not exist on disk, so the rule that no filtered workflow may `
      + `start on it is about nothing. Follow the file, or drop the entry deliberately.`,
    );
    const hosts = w.filtered
      .filter((file) => file !== SWIFT_PACKAGE)
      .filter((file) => matchesFilter(wPaths(w, file), fixture))
      .sort();
    need(
      hosts.length === 0,
      `"${fixture}" starts [${hosts.join(", ")}]. Nothing in those workflows reads it: ${why}. A `
      + `fixture list copied between workflows rather than derived from what each suite opens is `
      + `how a narrow filter grows back into a directory glob one line at a time.`,
    );
  }

  return out;
}

// ── 5. this policy's own hosted, always-on evidence ─────────────────────────
//
// Everything above is true only if something runs it. `repo-hygiene.yml` has no
// path filter, so it runs on every `main` push and — through `merge-gate.yml`,
// which calls it with NO condition — on every pull request. That is what makes
// an edit to THIS file, or to any workflow it judges, produce its own hosted
// evidence rather than landing unverified behind a filter that does not name it.
//
// "No path filter" and "called unconditionally" are the same property stated at
// the two levels that now exist, and both are asserted: a filter here, or an
// `if:` on the gate's caller job, is one line each and either one lets a
// boundary edit land with this policy never executed.

function selfHostFailures(w) {
  const out = [];
  const need = (ok, message) => { if (!ok) out.push(message); };

  const doc = w.docs.get(SELF_HOST);
  need(
    doc !== undefined,
    `${SELF_HOST} is missing, and it is what runs \`${SELF_COMMAND}\` on every pull request and `
    + `every \`main\` push.`,
  );
  if (!doc) return out;

  need(
    wPaths(w, SELF_HOST) === null,
    `${SELF_HOST} gained a push path filter (${JSON.stringify(wPaths(w, SELF_HOST))}). It hosts `
    + `this policy precisely because it has none: a filter would have to name every workflow, `
    + `fixture and consuming test this boundary reads, and the first one it forgot would be a `
    + `commit that changed the boundary without running its own guard.`,
  );
  // Branch work reaches this host through the gate now, not through a trigger
  // of its own. The old check asked whether a `pull_request:` this file no
  // longer declares had grown a path filter — a question whose answer is now
  // "no" for the wrong reason, and which would have kept reporting green with
  // the host unreachable from a pull request entirely.
  const selfOn = doc.on && typeof doc.on === "object" ? doc.on : {};
  need(
    Object.prototype.hasOwnProperty.call(selfOn, "workflow_call"),
    `${SELF_HOST} declares no \`workflow_call:\`, so ${AGGREGATE} cannot call it and branch work `
    + `reaches \`main\` without this boundary ever being judged. It is worse than that in `
    + `practice: an unresolvable \`uses:\` fails the entire gate run to load, so the required `
    + `context reports nothing at all.`,
  );
  need(
    !Object.prototype.hasOwnProperty.call(selfOn, "pull_request"),
    `${SELF_HOST} declares its own \`pull_request\` trigger again. ${AGGREGATE} already calls it `
    + `unconditionally, so every commit on a branch with an open pull request runs all of this `
    + `host's jobs twice for one answer.`,
  );

  const gate = w.docs.get(AGGREGATE);
  need(
    gate !== undefined,
    `${AGGREGATE} is missing or did not parse, and it is what runs \`${SELF_COMMAND}\` on a pull `
    + `request now that ${SELF_HOST} has no \`pull_request\` trigger of its own.`,
  );
  if (gate !== undefined) {
    const callers = Object.entries(gate.jobs ?? {})
      .filter(([, job]) => job?.uses === `./.github/workflows/${SELF_HOST}`)
      .map(([name]) => name)
      .sort();
    need(
      callers.length === 1,
      `${AGGREGATE} declares ${callers.length} job(s) [${callers.join(", ")}] with `
      + `\`uses: ./.github/workflows/${SELF_HOST}\`; want exactly one. Zero is this entire policy `
      + `— and every other cross-cutting guard hosted there — not running on any pull request, `
      + `while the filtered lanes keep reporting green.`,
    );
    need(
      callers.length !== 1 || callers[0] === SELF_HOST_GATE_JOB,
      `${AGGREGATE} calls ${SELF_HOST} from job "${callers[0]}"; want "${SELF_HOST_GATE_JOB}".`,
    );
    for (const name of callers) {
      const caller = gate.jobs?.[name];
      need(
        caller?.if === undefined,
        `${AGGREGATE}/${name} has grown \`if: ${JSON.stringify(caller?.if)}\`. This is the lane `
        + `the gate must call with NO condition: it hosts the checks every change has to pass, and `
        + `a condition here is the same hole a path filter on ${SELF_HOST} would be — reached by `
        + `whichever pull requests the expression happens to select, and by no others.`,
      );
    }
  }

  const jobs = Object.entries(doc.jobs ?? {})
    .filter(([, job]) => realRunLines(job).some((line) => line.includes(SELF_COMMAND)));
  need(
    jobs.length === 1,
    `${jobs.length} job(s) in ${SELF_HOST} run \`${SELF_COMMAND}\`; want exactly one. Zero is a `
    + `policy file nothing executes — every rule above then holds only on the author's machine, `
    + `and the isolation it protects can be undone by a one-line filter edit that no check sees.`,
  );
  for (const [name, job] of jobs) {
    need(
      job.if === undefined,
      `${SELF_HOST}/${name}: a job-level "if:" lets the job that runs \`${SELF_COMMAND}\` skip `
      + `itself, and a skipped check reports NOTHING rather than red.`,
    );
    need(
      job["continue-on-error"] === undefined,
      `${SELF_HOST}/${name}: continue-on-error makes this boundary advisory.`,
    );
    const timeout = Number(job["timeout-minutes"]);
    need(
      Number.isFinite(timeout) && timeout > 0,
      `${SELF_HOST}/${name}: timeout-minutes is ${JSON.stringify(job["timeout-minutes"])}, want a `
      + `finite positive number; undeclared it is GitHub's six-hour default.`,
    );
    need(
      !(Number.isFinite(timeout) && timeout > SELF_TIMEOUT_MAX),
      `${SELF_HOST}/${name}: timeout-minutes is ${JSON.stringify(job["timeout-minutes"])}, above `
      + `the ${SELF_TIMEOUT_MAX}-minute ceiling. This policy parses eight small YAML documents and `
      + `reads six files; a bound large enough to hide a hang is the six-hour default with extra `
      + `steps.`,
    );
    for (const step of job.steps ?? []) {
      need(
        step.if === undefined,
        `${SELF_HOST}/${name}: a step sets "if:", and a policy that can skip itself is not a `
        + `policy.`,
      );
      need(
        step["continue-on-error"] === undefined,
        `${SELF_HOST}/${name}: a step sets continue-on-error, which lets the job report green `
        + `after this boundary failed.`,
      );
    }
    const line = realRunLines(job).find((l) => l.includes(SELF_COMMAND));
    need(
      !/\|\|\s*(true|:|echo|exit 0)/.test(line ?? ""),
      `${SELF_HOST}/${name}: the \`${SELF_COMMAND}\` command swallows its own exit status `
      + `(${JSON.stringify(line ?? "")}), so the job reports green after this boundary failed.`,
    );
  }

  return out;
}

const CHECKS = [laneFailures, negationFailures, ownershipFailures, fixtureFailures, selfHostFailures];

for (const rule of CHECKS) {
  for (const message of rule(world())) failures.push(message);
}

// ── 6. the proof that every rule above can still fail ───────────────────────
//
// Every rule reads a world instead of module state precisely so this can exist.
// Each case below breaks ONE property in a copy of the real workflows and
// requires the matching complaint BY ITS OWN WORDING — not merely "something
// failed", which a broken parser or an unrelated typo would also satisfy.
//
// This is the guard against the most expensive outcome available here: a policy
// file that passes because it is asserting nothing.

/**
 * Set a workflow's `push` path filter.
 *
 * `push` is the only filtered event these lanes have left. This helper used to
 * write the same list under `pull_request` as well, mirroring the anchor the
 * workflows carried — which would now WRITE BACK the direct trigger section 1b′
 * forbids, so every path mutation below would raise an unrelated duplicate-run
 * complaint beside the one it means to prove. It touches `push` alone.
 */
function withPaths(w, file, paths) {
  const on = w.docs.get(file)?.on;
  if (!on || typeof on !== "object" || !on.push || typeof on.push !== "object") {
    throw new Error(`${file} declares no \`push\` mapping, so there is no path filter to set`);
  }
  on.push.paths = paths;
  return w;
}

/**
 * Remove exactly one entry from a workflow's shared filter.
 *
 * Derived from the world rather than restated as a replacement list, so it
 * removes ONE thing however the filter grows later, and throws when the entry is
 * already gone. A mutation that quietly stopped removing anything would leave
 * the world unbroken, and the case below it would pass while asserting nothing.
 */
function withoutPath(w, file, path) {
  const paths = wPaths(w, file);
  if (paths === null || !paths.includes(path)) {
    throw new Error(`${file}'s path filter does not list ${path}, so there is nothing to remove`);
  }
  return withPaths(w, file, paths.filter((entry) => entry !== path));
}

/** Mutate the job called `name`, and throw when the file does not declare it. */
function withNamedJob(w, file, name, mutate) {
  const job = w.docs.get(file)?.jobs?.[name];
  if (job === undefined) throw new Error(`${file} declares no job named ${name}`);
  mutate(job);
  return w;
}

/**
 * Mutate the job in `file` that runs `command`, and the step carrying it.
 *
 * Throws for the same reason `withoutPath` does: a mutation that silently
 * stopped applying leaves the world unbroken and the case passes by asserting
 * nothing.
 */
function withCommandJob(w, file, command, mutate) {
  for (const [name, job] of Object.entries(w.docs.get(file)?.jobs ?? {})) {
    const step = (job.steps ?? []).find((s) => String(s?.run ?? "").includes(command));
    if (step) { mutate(job, step, name); return w; }
  }
  throw new Error(`no job in ${file} runs ${command}`);
}

const MUTATIONS = [
  // ── the negation: deleted, narrowed, reordered, re-included ───────────────
  {
    // The whole boundary, deleted by deleting one line.
    name: "macos.yml drops the !apps/RelayiumKit/Tests/** negation",
    mutate: (w) => withoutPath(w, MACOS, PACKAGE_TESTS_NEGATION),
    expect: /macos\.yml's path filter does not list `!apps\/RelayiumKit\/Tests\/\*\*`/,
  },
  {
    // The same edit read as BEHAVIOUR rather than as list membership — the half
    // that still fires when the negation is present but wrong.
    name: "ios.yml drops the negation, so an ordinary Swift test starts two xcodebuild graphs",
    mutate: (w) => withoutPath(w, IOS, PACKAGE_TESTS_NEGATION),
    expect: /AeadTests\.swift" starts \[ios\.yml, swift-package\.yml\]/,
  },
  {
    // Present, correctly ordered, and covering almost nothing. Every literal
    // `indexOf` check still passes; only the compiled semantics notice. This is
    // what a "be more surgical" edit looks like.
    name: "the negation is narrowed to the fixtures directory only",
    mutate: (w) => withPaths(w, MACOS, [
      "apps/mac/**",
      PACKAGE_SOURCE_GLOB,
      `!${PACKAGE_FIXTURES_ROOT}/**`,
      `.github/workflows/${MACOS}`,
    ]),
    expect: /AeadTests\.swift" starts \[macos\.yml, swift-package\.yml\]/,
  },
  {
    // Present, correct, and in the wrong ORDER — the mutation only
    // last-match-wins semantics can see at all.
    name: "macos.yml puts the negation ABOVE the positive it qualifies",
    mutate: (w) => withPaths(w, MACOS, [
      "apps/mac/**",
      PACKAGE_TESTS_NEGATION,
      PACKAGE_SOURCE_GLOB,
      `.github/workflows/${MACOS}`,
    ]),
    expect: /macos\.yml lists `!apps\/RelayiumKit\/Tests\/\*\*` at position 2, BEFORE/,
  },
  {
    // The same reordering in the pairing filter, judged by behaviour: the
    // exclusion is overridden and the 45-minute runner comes back.
    name: "native-web-pairing.yml puts the negation above the positive",
    mutate: (w) => withPaths(w, NWP, [
      PACKAGE_TESTS_NEGATION,
      PACKAGE_SOURCE_GLOB,
      "web/**",
      "server/**",
      "scripts/native-web-pairing-acceptance.sh",
      "scripts/lib/local-acceptance.sh",
      `.github/workflows/${NWP}`,
    ]),
    expect: /native-web-pairing\.yml lists `!apps\/RelayiumKit\/Tests\/\*\*` at position 1, BEFORE/,
  },
  {
    // The over-broad negation, in the other direction: the package's SOURCE
    // stops starting the lanes that compile it. A missing run and a surplus run
    // are one decision made opposite ways, so both are mutated.
    name: "the negation is widened until the package's own source stops triggering",
    mutate: (w) => withPaths(w, NWP, [
      PACKAGE_SOURCE_GLOB,
      `!${PACKAGE_SOURCE_GLOB}`,
      "web/**",
      "server/**",
      "scripts/native-web-pairing-acceptance.sh",
      "scripts/lib/local-acceptance.sh",
      `.github/workflows/${NWP}`,
    ]),
    expect: /SealedBox\.swift" starts \[ios\.yml, macos\.yml, swift-package\.yml\]/,
  },
  {
    // The back door: the negation stays, and a later positive re-includes what
    // it excluded. This reads in a diff as "we do need the vectors after all",
    // and it buys back the whole 45-minute pairing runner for files the run
    // never opens.
    name: "native-web-pairing.yml re-includes the fixtures after the negation",
    mutate: (w) => withPaths(w, NWP, [
      PACKAGE_SOURCE_GLOB,
      PACKAGE_TESTS_NEGATION,
      `${PACKAGE_FIXTURES_ROOT}/**`,
      "web/**",
      "server/**",
      "scripts/native-web-pairing-acceptance.sh",
      "scripts/lib/local-acceptance.sh",
      `.github/workflows/${NWP}`,
    ]),
    expect: /native-web-pairing\.yml's path filter lists `apps\/RelayiumKit\/Tests\/Fixtures\/\*\*`/,
  },
  {
    // The same re-inclusion written as one file rather than a tree — narrower,
    // still not an input, and caught by the non-input rule instead of by the
    // tree-glob one.
    name: "ios.yml re-includes one fixture it does not read",
    mutate: (w) => withPaths(w, IOS, [
      "apps/ios/**",
      PACKAGE_SOURCE_GLOB,
      PACKAGE_TESTS_NEGATION,
      `${PACKAGE_FIXTURES_ROOT}/store-wire-vectors.json`,
      "scripts/ios-ui-session-acceptance.sh",
      "scripts/local-transfer-acceptance.sh",
      "scripts/local-transfer-cleanup-test.sh",
      "scripts/lib/local-acceptance.sh",
      `.github/workflows/${IOS}`,
    ]),
    expect: /store-wire-vectors\.json" starts \[ios\.yml\]/,
  },
  {
    // A second heavy owner of the excluded subtree: one test edit is back to two
    // macOS runners.
    name: "the pairing lane becomes a second heavy owner of the package's test target",
    mutate: (w) => withoutPath(w, NWP, PACKAGE_TESTS_NEGATION),
    expect: /starts \[native-web-pairing\.yml\] besides swift-package\.yml/,
  },
  {
    // A filter of nothing but exclusions. Valid YAML, happy actionlint, and a
    // workflow that never runs on any event — which reports as no check rather
    // than as a red one.
    name: "a filtered workflow is left with only negative patterns",
    mutate: (w) => withPaths(w, SWIFT_PACKAGE, [
      PACKAGE_TESTS_NEGATION,
      `!${SWIFT_PACKAGE_DIR}/Sources/**`,
    ]),
    expect: /swift-package\.yml's path filter has no positive pattern/,
  },

  // ── the lane itself ───────────────────────────────────────────────────────
  {
    // Zero owners: the package lane narrows to Sources, and everything three
    // heavy filters exclude becomes source that starts no filtered workflow at
    // all.
    name: "swift-package.yml narrows to Sources, leaving the test target with no owner",
    mutate: (w) => withPaths(w, SWIFT_PACKAGE, [
      `${SWIFT_PACKAGE_DIR}/Sources/**`,
      `.github/workflows/${SWIFT_PACKAGE}`,
    ]),
    expect: /AeadTests\.swift" starts NO path-filtered workflow/,
  },
  {
    // The same failure written as an exclusion inside the one filter that may
    // not have one.
    name: "swift-package.yml excludes the fixtures it is the only owner of",
    mutate: (w) => withPaths(w, SWIFT_PACKAGE, [
      PACKAGE_SOURCE_GLOB,
      `!${PACKAGE_FIXTURES_ROOT}/**`,
      `.github/workflows/${SWIFT_PACKAGE}`,
    ]),
    expect: /swift-package\.yml's path filter carries an exclusion/,
  },
  {
    // The whole lane deleted with the three negations left in place: the
    // expensive silent outcome, because every heavy board still reports green.
    name: "swift-package.yml disappears while the heavy filters keep excluding its subtree",
    mutate: (w) => {
      w.docs.delete(SWIFT_PACKAGE);
      w.texts.delete(SWIFT_PACKAGE);
      w.filtered = w.filtered.filter((file) => file !== SWIFT_PACKAGE);
      return w;
    },
    expect: /swift-package\.yml is missing or did not parse/,
  },

  // ── reachability from a pull request, now the gate's job (1b′) ────────────
  //
  // The case these replace made `push` and `pull_request` disagree. With that
  // trigger gone the two cannot disagree, so the mutation proved a rule that no
  // longer exists. Each of these breaks a property that IS still real: the lane
  // is reachable from a branch only while it declares `workflow_call:`, only
  // while the gate calls it, and only while the gate itself starts on every
  // pull request.
  {
    // The direct trigger, restored beside the call. Two PAID macOS runners for
    // every commit on a branch with an open pull request, one answer.
    name: "swift-package.yml takes its own pull_request trigger back",
    mutate: (w) => {
      w.docs.get(SWIFT_PACKAGE).on.pull_request = {
        paths: [PACKAGE_SOURCE_GLOB, `.github/workflows/${SWIFT_PACKAGE}`],
      };
      return w;
    },
    expect: /swift-package\.yml declares its own `pull_request` trigger again/,
  },
  {
    // The opposite edit, and the one that takes the whole board with it: the
    // gate's `uses:` stops resolving and the entire run fails to LOAD, so the
    // required context reports nothing rather than red.
    name: "swift-package.yml drops workflow_call, so the gate's uses: cannot resolve",
    mutate: (w) => {
      delete w.docs.get(SWIFT_PACKAGE).on.workflow_call;
      return w;
    },
    expect: /swift-package\.yml declares no `workflow_call:`/,
  },
  {
    // Both files stay valid and the package suite simply stops being reachable
    // from a pull request, while three heavy filters keep excluding its subtree
    // on the strength of it. This is the quiet, expensive one.
    name: "merge-gate stops calling the package lane",
    mutate: (w) => {
      delete w.docs.get(AGGREGATE).jobs[SWIFT_PACKAGE_GATE_JOB];
      return w;
    },
    expect: /merge-gate\.yml declares 0 job\(s\) \[\] with `uses: \.\/\.github\/workflows\/swift-package\.yml`/,
  },
  {
    // The gate filtered: it emits no check run for the pull requests it skips,
    // which is the absent-check failure the lanes were converted to avoid —
    // reintroduced one level up and for every lane at once.
    name: "the merge gate's pull_request trigger grows a path filter",
    mutate: (w) => {
      w.docs.get(AGGREGATE).on.pull_request = { paths: ["web/**"] };
      return w;
    },
    expect: /merge-gate\.yml's `pull_request` trigger has grown a path filter/,
  },
  {
    // The always-on host, made conditional at the CALLER instead of by a path
    // filter on the callee. Same hole, one level up, and invisible to every
    // rule that reads `repo-hygiene.yml` alone.
    name: "merge-gate gives the repo-hygiene lane a condition it can skip under",
    mutate: (w) => withNamedJob(w, AGGREGATE, SELF_HOST_GATE_JOB, (job) => {
      job.if = "github.event.pull_request.draft == false";
    }),
    expect: /merge-gate\.yml\/repo-hygiene has grown `if:/,
  },
  {
    // And the callee side of the same property: this policy's host stops being
    // callable, so nothing executes it on a pull request at all.
    name: "repo-hygiene.yml drops workflow_call, so nothing runs this policy on a pull request",
    mutate: (w) => {
      delete w.docs.get(SELF_HOST).on.workflow_call;
      return w;
    },
    expect: /repo-hygiene\.yml declares no `workflow_call:`/,
  },
  {
    name: "swift-package.yml's job can skip itself",
    mutate: (w) => withNamedJob(w, SWIFT_PACKAGE, SWIFT_PACKAGE_JOB, (job) => {
      job.if = "github.event_name != 'pull_request'";
    }),
    expect: /swift-package\.yml\/swift-test: a job-level "if:"/,
  },
  {
    name: "swift-package.yml's job becomes advisory",
    mutate: (w) => withNamedJob(w, SWIFT_PACKAGE, SWIFT_PACKAGE_JOB, (job) => {
      job["continue-on-error"] = "true";
    }),
    expect: /swift-package\.yml\/swift-test: continue-on-error/,
  },
  {
    name: "swift-package.yml's suite swallows its own exit status",
    mutate: (w) => withCommandJob(w, SWIFT_PACKAGE, "swift test", (job, step) => {
      step.run = "swift test || true\n";
    }),
    expect: /swift-package\.yml\/swift-test: a command swallows its own exit status/,
  },
  {
    name: "swift-package.yml's job loses its finite bound",
    mutate: (w) => withNamedJob(w, SWIFT_PACKAGE, SWIFT_PACKAGE_JOB, (job) => {
      delete job["timeout-minutes"];
    }),
    expect: /swift-package\.yml\/swift-test: timeout-minutes is undefined/,
  },
  {
    // A second job on the PAID runner. It has to be a deliberate decision, in
    // this file and in `RUNNER_BUDGETS`, not a quiet second macOS charge per
    // package commit.
    name: "swift-package.yml gains a second macOS job",
    mutate: (w) => {
      w.docs.get(SWIFT_PACKAGE).jobs.lint = {
        "runs-on": "macos-15",
        "timeout-minutes": "20",
        steps: [{ name: "swift build", run: "swift build\n" }],
      };
      return w;
    },
    expect: /swift-package\.yml declares jobs \[swift-test, lint\]/,
  },
  {
    name: "swift-package.yml grows a retry around its suite",
    mutate: (w) => {
      w.texts.set(
        SWIFT_PACKAGE,
        `${w.texts.get(SWIFT_PACKAGE)}\n          swift test || swift test # retry\n`,
      );
      return w;
    },
    expect: /swift-package\.yml retries/,
  },
  {
    name: "swift-package.yml starts reading a repository secret",
    mutate: (w) => {
      w.texts.set(
        SWIFT_PACKAGE,
        `${w.texts.get(SWIFT_PACKAGE)}\n          TOKEN: \${{ secrets.SOME_TOKEN }}\n`,
      );
      return w;
    },
    expect: /swift-package\.yml reads a repository secret/,
  },

  // ── the sole unfiltered `swift test` ──────────────────────────────────────
  {
    // Filtered, so nothing runs the whole suite. `ios.yml`'s five narrow guard
    // selectors would be the only Swift testing left.
    name: "swift-package.yml's swift test gains a filter",
    mutate: (w) => withCommandJob(w, SWIFT_PACKAGE, "swift test", (job, step) => {
      step.run = "swift test --filter 'RelayiumKitTests.AeadTests'\n";
    }),
    expect: /0 unfiltered `swift test` step\(s\) exist/,
  },
  {
    // Duplicated back into the macOS signing workflow: two PAID runners, one
    // answer, and one of the two behind a filter that excludes the very files
    // the suite is about.
    name: "the unfiltered swift test is duplicated back into macos.yml",
    mutate: (w) => withNamedJob(w, MACOS, "test", (job) => {
      job.steps.push({
        name: "swift test",
        "working-directory": SWIFT_PACKAGE_DIR,
        run: "swift test\n",
      });
    }),
    expect: /2 unfiltered `swift test` step\(s\) exist/,
  },
  {
    // Kept, unfiltered, and run from the wrong directory — where it tests a
    // different package or fails outright.
    name: "the unfiltered swift test loses its working directory",
    mutate: (w) => withCommandJob(w, SWIFT_PACKAGE, "swift test", (job, step) => {
      delete step["working-directory"];
    }),
    expect: /the unfiltered `swift test` declares working-directory undefined/,
  },
  {
    // The third host, in a workflow this policy does not parse — invisible to
    // the structural count, caught by the on-disk text scan.
    name: "an unparsed workflow gains a swift test of its own",
    mutate: (w) => {
      w.texts.set(AUTO_RELEASE, `${w.texts.get(AUTO_RELEASE)}\n        run: swift test\n`);
      return w;
    },
    expect: /`swift test` appears in \[auto-release\.yml, contracts\.yml, ios\.yml, swift-package\.yml\]/,
  },

  // ── the contract lane's third `swift test` (1f, 1g) ───────────────────────
  {
    // The cheap lane quietly becomes the package suite: same runner, same
    // trigger, forty times the work, and nothing about the YAML looks different.
    name: "contracts.yml's swift test loses its --filter",
    mutate: (w) => withCommandJob(w, CONTRACTS, "swift test", (job, step) => {
      step.run = "swift test\n";
    }),
    expect: /contracts\.yml's `swift test` selects \[\]; want exactly/,
  },
  {
    // The selector widens to the whole target — one argument, and the lane is a
    // second package suite started by every contract edit.
    name: "contracts.yml's swift test selector widens to the whole test target",
    mutate: (w) => withCommandJob(w, CONTRACTS, "swift test", (job, step) => {
      step.run = `swift test --filter '${SWIFT_TEST_TARGET}'\n`;
    }),
    expect: /contracts\.yml's `swift test` selects \["RelayiumKitTests"\]/,
  },
  {
    // Run from the repository root, where SwiftPM resolves a different package
    // or none at all.
    name: "contracts.yml's swift test loses its working directory",
    mutate: (w) => withCommandJob(w, CONTRACTS, "swift test", (job, step) => {
      delete step["working-directory"];
    }),
    expect: /contracts\.yml's `swift test` declares working-directory undefined/,
  },
  {
    // The contract lane reaches into the package it does not compile. Every
    // ordinary Swift edit then starts TWO paid macOS lanes for one answer.
    name: "contracts.yml's filter grows into the shared Swift package",
    mutate: (w) => withPaths(w, CONTRACTS, [...wPaths(w, CONTRACTS), PACKAGE_SOURCE_GLOB]),
    expect: /contracts\.yml's path filter names `apps\/RelayiumKit`/,
  },

  // ── the fixtures ──────────────────────────────────────────────────────────
  {
    // The Go half of the manifest contract, dropped. The fixture is then inside
    // an excluded subtree for every heavy workflow and named by no Go one, so
    // the vectors change and `vectors_test.go` never runs on the commit.
    name: "go.yml drops the device-inbox fixture it reads",
    mutate: (w) => withoutPath(
      w, GO, `${PACKAGE_FIXTURES_ROOT}/device-inbox-manifest-v3-vectors.json`,
    ),
    expect: /go\.yml's path filter does not list "apps\/RelayiumKit\/Tests\/Fixtures\/device-inbox-manifest-v3-vectors\.json" verbatim/,
  },
  {
    name: "web.yml drops one of the three fixtures its suite reads",
    mutate: (w) => withoutPath(w, WEB, `${PACKAGE_FIXTURES_ROOT}/crypto-vectors.json`),
    expect: /web\.yml's path filter does not list "apps\/RelayiumKit\/Tests\/Fixtures\/crypto-vectors\.json" verbatim/,
  },
  {
    // The lazy repair of the case above: name the directory instead of the
    // files. It fixes the dropped fixture and starts the full web suite, the
    // accessibility scan and three headless-Chrome journeys on every Swift test
    // edit.
    name: "web.yml replaces its three fixture paths with the whole Fixtures tree",
    mutate: (w) => withPaths(w, WEB, [
      "web/**",
      `${PACKAGE_FIXTURES_ROOT}/**`,
      `.github/workflows/${WEB}`,
    ]),
    expect: /web\.yml's path filter lists `apps\/RelayiumKit\/Tests\/Fixtures\/\*\*`/,
  },
  {
    // The entry stays and a later exclusion swallows it: the line is present,
    // the diff looks right, and the suite still does not run on the commit that
    // changed the bytes.
    name: "web.yml keeps a fixture entry and excludes it further down the list",
    mutate: (w) => withPaths(w, WEB, [
      ...wPaths(w, WEB),
      `!${PACKAGE_FIXTURES_ROOT}/crypto-vectors.json`,
    ]),
    expect: /web\.yml lists "apps\/RelayiumKit\/Tests\/Fixtures\/crypto-vectors\.json" but does not actually trigger on it/,
  },
  {
    // The consumer stops reading its fixture while the filter keeps naming it.
    // Nothing in the YAML changes, and the entry is now charging a full suite
    // for a file nobody opens.
    name: "a fixture consumer stops reading the fixture its workflow filters on",
    mutate: (w) => {
      w.fixtureConsumers.set(
        "server/internal/inboxmanifest/vectors_test.go",
        "package inboxmanifest\n\n// the vectors are gone\n",
      );
      return w;
    },
    expect: /no longer names "device-inbox-manifest-v3-vectors\.json"/,
  },
  {
    // And the fixture itself renamed out from under every filter that names it.
    name: "a filtered fixture no longer exists on disk",
    mutate: (w) => {
      w.fixtures.delete(`${PACKAGE_FIXTURES_ROOT}/crypto-vectors.json`);
      return w;
    },
    expect: /the fixture "apps\/RelayiumKit\/Tests\/Fixtures\/crypto-vectors\.json" does not exist on disk/,
  },

  // ── the closed set, and this policy's own hosting ─────────────────────────
  {
    // A new path-filtered workflow nobody told this file about. Every ownership
    // rule above is a claim about ALL filtered workflows, so a set that grows
    // behind its back is a claim that quietly stopped being checked.
    name: "a new path-filtered workflow appears that this policy does not know about",
    mutate: (w) => {
      w.texts.set("android.yml", "on:\n  push:\n    paths:\n      - 'apps/android/**'\n");
      w.filtered = [...w.filtered, "android.yml"].sort();
      return w;
    },
    expect: /\[android\.yml\] declare a `paths:` filter but are not in this file's PARSED list/,
  },
  {
    name: "repo-hygiene.yml stops running this policy",
    mutate: (w) => withCommandJob(w, SELF_HOST, SELF_COMMAND, (job, step) => {
      step.run = String(step.run).replace(SELF_COMMAND, "true");
    }),
    expect: /0 job\(s\) in repo-hygiene\.yml run `node scripts\/test\/swift-ci-boundary-test\.mjs`/,
  },
  {
    name: "the job hosting this policy becomes advisory",
    mutate: (w) => withCommandJob(w, SELF_HOST, SELF_COMMAND, (job) => {
      job["continue-on-error"] = "true";
    }),
    expect: /repo-hygiene\.yml\/swift-ci-boundary: continue-on-error/,
  },
  {
    name: "the job hosting this policy swallows its exit status",
    mutate: (w) => withCommandJob(w, SELF_HOST, SELF_COMMAND, (job, step) => {
      step.run = `${SELF_COMMAND} || true\n`;
    }),
    expect: /the `node scripts\/test\/swift-ci-boundary-test\.mjs` command swallows its own exit status/,
  },
  {
    name: "repo-hygiene.yml gains a path filter, so a boundary edit can land unjudged",
    mutate: (w) => withPaths(w, SELF_HOST, ["web/**", `.github/workflows/${SELF_HOST}`]),
    expect: /repo-hygiene\.yml gained a push path filter/,
  },

  // ── the legitimate shapes this file must NOT complain about ───────────────
  {
    // A real source change carrying its own test. Every heavy Apple lane still
    // has to start, and no rule above may read that as a leak.
    name: "a shared-source change lands together with its own new test",
    mutate: (w) => w,
    refute: /a shared-source change with its own test in the same commit .* starts/,
  },
  {
    // `go.yml` and `web.yml` naming individual files inside a subtree three
    // other workflows exclude. Narrow entries into an excluded tree are the
    // design, not a leak, and a rule that flagged them would be widened until it
    // caught nothing.
    name: "go.yml and web.yml keep naming individual fixtures inside the excluded subtree",
    mutate: (w) => w,
    refute: /(go|web)\.yml's path filter lists `apps\/RelayiumKit\/Tests/,
  },
  {
    // A SECOND, filtered `swift test` beside the unfiltered one is a legitimate
    // shape — a fast pre-check — and must not read as "the whole suite stopped
    // running" nor as a second unfiltered host.
    name: "swift-package.yml adds a fast filtered swift test beside its unfiltered one",
    mutate: (w) => withNamedJob(w, SWIFT_PACKAGE, SWIFT_PACKAGE_JOB, (job) => {
      job.steps.unshift({
        name: "swift test (fast pre-check)",
        "working-directory": SWIFT_PACKAGE_DIR,
        run: "swift test --filter 'RelayiumKitTests.AeadTests'\n",
      });
    }),
    refute: /unfiltered `swift test` step\(s\) exist/,
  },
];

for (const { name, mutate, expect, refute } of MUTATIONS) {
  let got;
  try {
    const mutated = mutate(world());
    got = CHECKS.flatMap((rule) => rule(mutated));
  } catch (err) {
    check(false, `the Swift CI boundary mutation "${name}" threw instead of reporting: ${err.message}`);
    continue;
  }
  const rendered = got.length === 0 ? "no failures at all" : `[\n    ${got.join("\n    ")}\n  ]`;
  if (expect) {
    check(
      got.some((message) => expect.test(message)),
      `the Swift CI boundary did NOT complain about "${name}". Expected a message matching `
      + `${expect}; got ${rendered}. A check that cannot fail for the reason it was written is not `
      + `a check, and this one would report green while the boundary it names is already gone.`,
    );
  }
  // The opposite obligation. A boundary that fires on shapes which are actually
  // fine gets widened until it fires on nothing, so the false positive and the
  // missing check have the same destination.
  if (refute) {
    check(
      !got.some((message) => refute.test(message)),
      `the Swift CI boundary complained about "${name}", which is a legitimate shape. Expected NO `
      + `message matching ${refute}; got ${rendered}.`,
    );
  }
}

// ── report ──────────────────────────────────────────────────────────────────

if (failures.length > 0) {
  console.error(`swift-ci-boundary-test: ${failures.length} failure(s)\n`);
  for (const message of failures) console.error(`  ✗ ${message}\n`);
  process.exit(1);
}
console.log(
  `swift-ci-boundary-test: OK (${SWIFT_PACKAGE} owns the repository's sole unfiltered `
  + `\`swift test\` in one finite, secret-free, unsigned macOS job; `
  + `\`${PACKAGE_TESTS_NEGATION}\` follows \`${PACKAGE_SOURCE_GLOB}\` in `
  + `${HEAVY_CONSUMERS.join(", ")}; ${OWNERSHIP.length} package paths and ${MIXED_DIFFS.length} `
  + `mixed diffs judged by compiled last-match-wins semantics across the `
  + `${filteredOnDisk.length} path-filtered workflows on disk (${filteredOnDisk.join(", ")}); `
  + `${FIXTURE_INPUTS.length} fixture(s) named one path at a time by their real `
  + `consumers and ${FIXTURE_NON_INPUTS.length} named by none; the package lane and this `
  + `policy's own host reachable from a pull request only through ${AGGREGATE}, whose `
  + `unfiltered \`pull_request\` trigger, one caller job each and unconditional `
  + `${SELF_HOST_GATE_JOB} call are read from disk rather than assumed; `
  + `${MUTATIONS.length} mutations prove each of those can fail)`,
);
