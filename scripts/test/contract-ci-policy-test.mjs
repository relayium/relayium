#!/usr/bin/env node
// scripts/test/contract-ci-policy-test.mjs — who owns each document in
// `contracts/`, what a contract-only edit is allowed to start, and what the lane
// that judges it may cost.
//
// ## The decision this file makes executable
//
// `docs/CI-PLATFORM-BOUNDARY.md` recorded, before any contract tree existed,
// that every workflow whose suite READS a file under one should name that file
// in its own path filter — the discipline `go.yml` and `web.yml` already apply
// to `device-inbox-manifest-v3-vectors.json`.
//
// Applied to `contracts/device-inbox-admission-v1.json` that rule costs far more
// than it buys. The document is read by two `go test` functions, one Vitest file
// and one XCTest class, together a few seconds of work — but naming it in the
// consumers' filters would start `go.yml`'s EIGHT-SHARD race lane, `web.yml`'s
// full Vite suite plus an accessibility scan and three headless-Chrome journeys,
// and would require widening `swift-package.yml` past the two entries that make
// it the one workflow guaranteed to see every file in the package.
//
// So the tree got cheap lanes of its own, running the smallest commands that
// judge each document's implementations. That decision has two halves and this
// file asserts both, because either alone is a regression:
//
//   * a contract-only edit starts THAT document's lane and the two ALWAYS-ON
//     gates, and starts none of the heavy product lanes;
//   * an ordinary Go, Web or Swift source change still starts its own owning
//     suite, and that suite still EXECUTES the consumer test.
//
// Drop the first and a document edit costs a paid macOS signing lane. Drop the
// second and the consumer tests exist in trees whose suites no longer run them,
// which is the same green-board-over-nothing shape with an extra file.
//
// ## Per document, not per tree
//
// `contracts.yml`'s filter was `contracts/**` while the tree held one document,
// on the recorded argument that a second should join the lane with no workflow
// edit. `contracts/ops-deploy-v1.json` refuted it: that document has no Swift
// and no TypeScript consumer, so a tree-wide filter would have charged a PAID
// macOS runner and an `npm ci` for every edit to it. Each document now names its
// own lane and its own consumers, and the guarantee the tree-wide filter used to
// give for free — that no contract file can exist unowned — is rule 1's orphan
// check, evaluated against the directory on disk.
//
// ## Why this is its own file
//
// `ci-event-policy-test.mjs` governs properties EVERY workflow has — triggers,
// concurrency, runner budgets — and is already the largest guard here.
// `swift-ci-boundary-test.mjs` governs one subtree's ownership and now also
// bounds `contracts.yml`'s third `swift test`. This file governs one tree's
// admission decision. Folding it into either would bury a contract nobody finds
// when the tree moves, and would grow the file every future contract has to be
// read through.
//
// ## Why order is load-bearing
//
// GitHub evaluates `paths:` against each changed file IN ORDER, and the LAST
// pattern that matches decides; a `!` entry excludes, a later positive entry
// re-includes, and a file no pattern matches does not match at all. Rules 2 and
// 3 therefore COMPILE each filter and evaluate it that way rather than testing
// list membership, and section 5 mutates the shapes that are invisible to list
// membership, to YAML validity and to actionlint.
//
// ## Why the YAML parser is written out here
//
// Same reason as `ci-event-policy-test.mjs`, `swift-ci-boundary-test.mjs` and
// `macos-publish-order-test.mjs`: `web/` is the only Node project in this
// repository, and a guard that runs on every pull request must not need
// `npm ci` first. The parser covers the subset these workflows use, THROWS on
// anything it does not understand rather than guessing, and is proved against an
// embedded fixture before anything it produces is trusted — a mis-read workflow
// is the one thing that could make every rule below pass vacuously.

import { readFileSync, readdirSync, existsSync } from "node:fs";
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

const CONTRACT_TREE = "contracts";

const CONTRACTS = "contracts.yml";
const OPS_DEPLOY = "ops-deploy-contract.yml";
const GO = "go.yml";
const WEB = "web.yml";
const SWIFT_PACKAGE = "swift-package.yml";
const COMPAT = "compat.yml";
const HYGIENE = "repo-hygiene.yml";

/** The lanes a document edit must never start. Each is a paid runner, a signing
 *  identity, a browser matrix or an eight-shard race — and not one of them opens
 *  a contract. */
const HEAVY_LANES = ["macos.yml", "ios.yml", "native-web-pairing.yml", GO, WEB];

/**
 * The declarative policies this tree owns, and the ceiling each may cost in the
 * unfiltered workflow that has to execute them.
 *
 * Both are pure file readers with no dependency to install, which is the whole
 * reason they can live in a lane with no path filter.
 */
const SELF_TESTS = [
  { test: "scripts/test/contract-ci-policy-test.mjs", timeoutMax: 5 },
  { test: "scripts/test/ops-deploy-contract-test.mjs", timeoutMax: 5 },
];

/**
 * The contract tree, one entry per DOCUMENT.
 *
 * ## Why ownership is per contract file and not per tree
 *
 * `contracts.yml`'s filter used to be `contracts/**`, on the recorded argument
 * that a second document should join the lane with no workflow edit at all.
 * `contracts/ops-deploy-v1.json` is that second document and it refuted the
 * argument: it has no Swift and no TypeScript consumer, so under a tree-wide
 * filter every edit to it would have taken a PAID macOS runner and an `npm ci`
 * to re-run two jobs that cannot open it — which is the same "charge a lane for
 * a file nobody reads" shape the contract lane was created to avoid.
 *
 * So each document names its own lane and its own consumers. What the tree-wide
 * filter used to guarantee for free — that no contract file can exist with no
 * owner — is now rule 1's orphan check, asserted directly against the tree on
 * disk.
 *
 * `runs` and `contractCommand` are checked against the workflows' real steps,
 * not assumed: a suite that stopped running the file its tree owns is the
 * failure those columns exist for.
 */
const OWNERSHIP = [
  {
    contract: `${CONTRACT_TREE}/device-inbox-admission-v1.json`,
    doc: "docs/DEVICE-INBOX-ADMISSION-CONTRACT.md",
    lane: CONTRACTS,
    // Three implementations parse this document independently and compare it to
    // the constants they already ship, so all three are checked — including the
    // paid macOS one, deliberately costed in `contracts.yml`'s own header.
    consumers: [
      {
        language: "Go",
        test: "server/account/deviceinbox_admission_contract_test.go",
        workflow: GO,
        runs: "go test ./...",
        contractJob: "go-contract",
        contractCommand: "go test ./account/ -run '^TestDeviceInboxAdmissionContract' -count=1",
        workingDirectory: "server",
        paidRunner: false,
      },
      {
        language: "Web",
        test: "web/src/lib/device-inbox-admission-contract.test.ts",
        workflow: WEB,
        runs: "npm test",
        contractJob: "web-contract",
        contractCommand: "npx vitest run src/lib/device-inbox-admission-contract.test.ts",
        workingDirectory: "web",
        paidRunner: false,
      },
      {
        language: "Swift",
        test: "apps/RelayiumKit/Tests/RelayiumKitTests/DeviceInboxAdmissionContractTests.swift",
        workflow: SWIFT_PACKAGE,
        runs: "swift test",
        contractJob: "swift-contract",
        contractCommand:
          "swift test --filter 'RelayiumKitTests.DeviceInboxAdmissionContractTests'",
        workingDirectory: "apps/RelayiumKit",
        paidRunner: true,
      },
    ],
  },
  {
    contract: `${CONTRACT_TREE}/ops-deploy-v1.json`,
    doc: "docs/OPS-DEPLOY-CONTRACT.md",
    lane: OPS_DEPLOY,
    // ONE consumer in a lane, and one free Ubuntu runner. The document's other
    // consumer is `scripts/test/ops-deploy-contract-test.mjs`, which needs no
    // toolchain and therefore runs in the UNFILTERED `repo-hygiene.yml` on every
    // commit — see `SELF_TESTS`. That is the more important half: it re-checks
    // every declared product path against `git ls-files`, so a `web/` or
    // `server/` change that invalidates the contract fails on the commit that
    // makes it. Listing it here as well would run one check twice for one
    // answer.
    consumers: [
      {
        language: "Go",
        test: "server/ops_deploy_contract_test.go",
        workflow: GO,
        runs: "go test ./...",
        contractJob: "go-contract",
        contractCommand: "go test ./ -run '^TestOpsDeployContract' -count=1",
        workingDirectory: "server",
        paidRunner: false,
      },
    ],
  },
];

/** Every consumer of every contract, each still knowing which document and lane
 *  it belongs to. */
const CONSUMERS = OWNERSHIP.flatMap((owner) =>
  owner.consumers.map((consumer) => ({ ...consumer, contract: owner.contract, lane: owner.lane })));

/** The lanes this tree owns, and the exact filter each must carry. */
const LANE_FILTERS = new Map(
  OWNERSHIP.map((owner) => [owner.lane, [owner.contract, `.github/workflows/${owner.lane}`]]));

// ── a parser for the YAML subset these workflows use ────────────────────────

/** Strip a trailing `#` comment that is not inside quotes. */
function stripComment(line) {
  let quote = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote) {
      if (c === quote) quote = null;
    } else if (c === "'" || c === '"') {
      quote = c;
    } else if (c === "#" && (i === 0 || /\s/.test(line[i - 1]))) {
      return line.slice(0, i);
    }
  }
  return line;
}

function scalar(raw) {
  const text = raw.trim();
  if (text === "") return "";
  if ((text.startsWith("'") && text.endsWith("'") && text.length > 1)
    || (text.startsWith('"') && text.endsWith('"') && text.length > 1)) {
    return text.slice(1, -1);
  }
  if (text === "true") return true;
  if (text === "false") return false;
  if (/^-?\d+$/.test(text)) return Number(text);
  return text;
}

/**
 * Parse the block-mapping / block-sequence / block-scalar / anchor subset.
 *
 * Throws on anything else. A parser that guessed would be the one failure that
 * makes every rule below pass over a document it never understood.
 */
function parseYaml(text) {
  const lines = [];
  text.split("\n").forEach((raw, i) => {
    if (raw.includes("\t")) throw new Error(`tab indentation at line ${i + 1}`);
    const stripped = stripComment(raw);
    if (stripped.trim() === "") return;
    lines.push({ indent: raw.length - raw.trimStart().length, body: stripped.trim(), n: i + 1, raw });
  });
  const anchors = new Map();

  // Block scalars are the one construct whose content is NOT parsed, so they are
  // collected from the raw text by indentation.
  function blockScalar(start, parentIndent) {
    const out = [];
    let i = start;
    // Measured from the first content line rather than assumed to be the key's
    // indent + 2: a deeper block would otherwise keep phantom leading spaces,
    // and a shallower one would have a character sliced off its command.
    const contentIndent = lines[start]?.indent ?? parentIndent + 2;
    while (i < lines.length && lines[i].indent > parentIndent) {
      out.push(lines[i].raw.slice(contentIndent));
      i++;
    }
    return [out.join("\n") + "\n", i];
  }

  function parseNode(i, indent) {
    if (i >= lines.length || lines[i].indent < indent) return [null, i];
    if (lines[i].body.startsWith("- ") || lines[i].body === "-") return parseSequence(i, indent);
    return parseMapping(i, indent);
  }

  function parseSequence(i, indent) {
    const out = [];
    while (i < lines.length && lines[i].indent === indent && lines[i].body.startsWith("-")) {
      const body = lines[i].body === "-" ? "" : lines[i].body.slice(2);
      if (body === "") {
        const [value, next] = parseNode(i + 1, indent + 2);
        out.push(value);
        i = next;
      } else if (/^[A-Za-z0-9_.-]+:( |$)/.test(body)) {
        // A mapping whose first key sits on the dash line. Re-read it as a
        // mapping starting at this line's key column.
        // The item is a mapping whose first key sits on the dash line. Re-read
        // it as a mapping starting at that key's column, then put the original
        // line back so nothing downstream sees the rewrite.
        const saved = lines[i];
        lines[i] = { indent: indent + 2, body, n: saved.n, raw: saved.raw };
        const [value, next] = parseMapping(i, indent + 2);
        lines[i] = saved;
        out.push(value);
        i = next;
      } else {
        out.push(scalar(body));
        i++;
      }
    }
    return [out, i];
  }

  function parseMapping(i, indent) {
    const out = {};
    while (i < lines.length && lines[i].indent === indent) {
      const { body, n } = lines[i];
      if (body.startsWith("-")) break;
      const at = body.indexOf(":");
      if (at < 0) throw new Error(`line ${n}: not a mapping entry: ${body}`);
      const key = body.slice(0, at).trim();
      let rest = body.slice(at + 1).trim();

      let anchor = null;
      const anchored = /^&([A-Za-z0-9_-]+)\s*(.*)$/.exec(rest);
      if (anchored) {
        anchor = anchored[1];
        rest = anchored[2];
      }
      const alias = /^\*([A-Za-z0-9_-]+)$/.exec(rest);

      let value;
      if (alias) {
        if (!anchors.has(alias[1])) throw new Error(`line ${n}: unknown alias *${alias[1]}`);
        value = anchors.get(alias[1]);
        i++;
      } else if (rest === "|" || rest === "|-" || rest === ">") {
        const [text, next] = blockScalar(i + 1, indent);
        value = text;
        i = next;
      } else if (rest === "") {
        // A key with no inline value owns the block BELOW it — but only when
        // that block is actually nested. A following line at this key's own
        // indent, or shallower, belongs to an enclosing mapping: descending
        // into it would make `workflow_dispatch:` swallow `jobs:` and every
        // rule below would then read a document with no jobs in it.
        const following = lines[i + 1];
        if (following !== undefined && following.indent > indent) {
          const [child, next] = parseNode(i + 1, following.indent);
          value = child;
          i = next;
        } else if (following !== undefined && following.indent === indent
          && following.body.startsWith("-")) {
          // A block sequence may sit at its key's own indentation.
          const [child, next] = parseSequence(i + 1, indent);
          value = child;
          i = next;
        } else {
          value = null;
          i++;
        }
      } else {
        value = scalar(rest);
        i++;
      }
      if (anchor) anchors.set(anchor, value);
      out[key] = value;
    }
    return [out, i];
  }

  const [value, consumed] = parseNode(0, 0);
  // Every line must have been consumed. A parser that silently drops a trailing
  // or mis-indented block is the one failure that makes every rule below pass
  // over a document it never fully read.
  if (consumed < lines.length) {
    throw new Error(`line ${lines[consumed].n}: unconsumed input: ${lines[consumed].body}`);
  }
  return value ?? {};
}

// ── the parser is proved before anything it produces is trusted ─────────────

const PARSER_FIXTURE = `# leading comment
name: fixture
on:
  push:
    branches:
      - main
    paths: &paths
      - 'contracts/**'
      - '!contracts/draft/**'
  pull_request:
    paths: *paths
permissions:
  contents: read
jobs:
  one:
    runs-on: ubuntu-latest
    timeout-minutes: 10
    steps:
      - uses: actions/checkout@abc # v6.0.2
      - name: two lines
        working-directory: server
        run: |
          go build ./...
          go test ./...
      - name: single
        run: echo hi
`;

(function proveTheParser() {
  const doc = parseYaml(PARSER_FIXTURE);
  const want = {
    name: "fixture",
    paths: ["contracts/**", "!contracts/draft/**"],
    aliasResolves: true,
    permissions: "read",
    runsOn: "ubuntu-latest",
    timeout: 10,
    uses: "actions/checkout@abc",
    blockScalar: "go build ./...\ngo test ./...\n",
    workingDirectory: "server",
    stepCount: 3,
  };
  const got = {
    name: doc.name,
    paths: doc.on?.push?.paths,
    aliasResolves: JSON.stringify(doc.on?.pull_request?.paths) === JSON.stringify(doc.on?.push?.paths),
    permissions: doc.permissions?.contents,
    runsOn: doc.jobs?.one?.["runs-on"],
    timeout: doc.jobs?.one?.["timeout-minutes"],
    uses: doc.jobs?.one?.steps?.[0]?.uses,
    blockScalar: doc.jobs?.one?.steps?.[1]?.run,
    workingDirectory: doc.jobs?.one?.steps?.[1]?.["working-directory"],
    stepCount: doc.jobs?.one?.steps?.length,
  };
  if (JSON.stringify(got) !== JSON.stringify(want)) {
    console.error("contract-ci-policy-test: the YAML parser does not read its own fixture.");
    console.error("  want", JSON.stringify(want));
    console.error("  got ", JSON.stringify(got));
    process.exit(1);
  }
  for (const bad of ["a:\n\tb: 1\n", "steps:\n  - name: x\n  not a mapping entry\n"]) {
    let threw = false;
    try { parseYaml(bad); } catch { threw = true; }
    if (!threw) {
      console.error("contract-ci-policy-test: the parser accepted input it does not understand:");
      console.error(JSON.stringify(bad));
      process.exit(1);
    }
  }
})();

// ── GitHub's ordered path-filter semantics, compiled ────────────────────────

/** One `paths:` entry compiled to a matcher, negation included. */
function compilePattern(pattern) {
  const negated = pattern.startsWith("!");
  const glob = negated ? pattern.slice(1) : pattern;
  // `**` crosses `/`; `*` and `?` do not. Everything else is literal.
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*" && glob[i + 1] === "*") {
      re += ".*";
      i++;
      if (glob[i + 1] === "/") i++;
      // `a/**` and `a/**/b` both allow zero segments, which `.*` already covers.
    } else if (c === "*") {
      re += "[^/]*";
    } else if (c === "?") {
      re += "[^/]";
    } else {
      re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  const compiled = new RegExp(`^${re}$`);
  return { negated, test: (file) => compiled.test(file) };
}

/**
 * Does `filter` start a workflow for `files`?
 *
 * GitHub tests each changed file against the list IN ORDER and the LAST pattern
 * that matches decides; a file matched by no pattern does not match at all. One
 * matching file is enough to start the workflow. A workflow with NO filter
 * always starts, which is why `compat.yml` and `repo-hygiene.yml` cannot be
 * routed around.
 */
function filterStarts(filter, files) {
  if (filter === null || filter === undefined) return true;
  const compiled = filter.map(compilePattern);
  return files.some((file) => {
    let verdict = false;
    for (const pattern of compiled) {
      if (pattern.test(file)) verdict = !pattern.negated;
    }
    return verdict;
  });
}

(function proveTheSemantics() {
  const cases = [
    [["contracts/**"], ["contracts/a.json"], true],
    [["contracts/**"], ["contracts/nested/a.json"], true],
    [["contracts/**"], ["docs/a.md"], false],
    // Order decides: the exclusion is last, so it wins.
    [["contracts/**", "!contracts/draft/**"], ["contracts/draft/a.json"], false],
    // Swapped, the exclusion is overridden by the pattern that qualifies it.
    [["!contracts/draft/**", "contracts/**"], ["contracts/draft/a.json"], true],
    // One matching file out of many is enough to start a workflow.
    [["contracts/**"], ["docs/a.md", "contracts/a.json"], true],
    // A single-star does not cross a separator.
    [["contracts/*.json"], ["contracts/nested/a.json"], false],
    [["contracts/*.json"], ["contracts/a.json"], true],
    // No filter at all always starts.
    [null, ["anything"], true],
  ];
  for (const [filter, files, want] of cases) {
    if (filterStarts(filter, files) !== want) {
      console.error("contract-ci-policy-test: the path-filter model is wrong for",
        JSON.stringify({ filter, files, want }));
      process.exit(1);
    }
  }
})();

// ── the world every rule reads ──────────────────────────────────────────────

function loadWorld() {
  const texts = new Map(
    readdirSync(workflowsDir)
      .filter((name) => /\.ya?ml$/.test(name))
      .map((name) => [name, readFileSync(resolve(workflowsDir, name), "utf8")]),
  );
  const docs = new Map();
  for (const [name, text] of texts) {
    try {
      docs.set(name, parseYaml(text));
    } catch (error) {
      throw new Error(`${name} did not parse: ${error.message}`);
    }
  }
  return { texts, docs, sources: new Map(), treeFiles: contractTreeFiles() };
}

/**
 * Every file in the contract tree, repository-relative and recursive.
 *
 * Read from the DIRECTORY rather than from a list in this file. That is the
 * whole point of the orphan rule below: a third contract has to appear here the
 * moment it is committed, without anyone remembering to add it, or the rule
 * would only ever check the documents somebody already thought about.
 */
function contractTreeFiles(root = CONTRACT_TREE) {
  const absolute = resolve(repoRoot, root);
  if (!existsSync(absolute)) return [];
  return readdirSync(absolute, { withFileTypes: true })
    .flatMap((entry) => (entry.isDirectory()
      ? contractTreeFiles(`${root}/${entry.name}`)
      : [`${root}/${entry.name}`]))
    .sort();
}

/** The tree's files, from the world so a mutation can add one. */
const treeFiles = (world) => world.treeFiles ?? [];

/** A workflow's push path filter, or null when it declares none. */
function wPaths(world, file) {
  const paths = world.docs.get(file)?.on?.push?.paths;
  return Array.isArray(paths) ? paths : null;
}

/** Read a repository file, remembering it so a mutation can replace it. */
function source(world, relativePath) {
  if (world.sources.has(relativePath)) return world.sources.get(relativePath);
  const absolute = resolve(repoRoot, relativePath);
  const text = existsSync(absolute) ? readFileSync(absolute, "utf8") : null;
  world.sources.set(relativePath, text);
  return text;
}

/** Every non-comment, non-placeholder run line of a job. */
function realRunLines(job) {
  return (job?.steps ?? [])
    .flatMap((step) => String(step?.run ?? "").split("\n"))
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"))
    .filter((line) => !/^(echo\b|printf\b|true$|:$|exit 0$|set\s+-|shopt\b)/.test(line));
}

const deepEqual = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// ── 1. every contract has an owner, and its consumers really read it ────────
//
// Everything below is a claim about documents that tests open. If a document is
// gone, or a test stopped naming it, every ownership rule is reasoning about a
// file nobody reads — the direction that decays without anyone editing a
// workflow.
//
// The orphan check is new with the second contract. While the lane's filter was
// `contracts/**` the tree could not hold an unowned file; now that ownership is
// per document, "somebody added a third contract and gave it no lane" is a real
// state, it leaves every workflow valid, and nothing but this rule notices.

function ownershipFailures(world) {
  const out = [];
  const need = (ok, message) => { if (!ok) out.push(message); };

  for (const owner of OWNERSHIP) {
    const contract = source(world, owner.contract);
    need(
      contract !== null,
      `${owner.contract} does not exist, but ${owner.lane} exists to run `
      + `${owner.consumers.length} test(s) against it and this policy exists to bound what that `
      + `costs. A lane whose subject is gone reports green over nothing.`,
    );
    if (contract !== null) {
      let parsed = null;
      try { parsed = JSON.parse(contract); } catch (error) {
        need(false, `${owner.contract} is not valid JSON: ${error.message}`);
      }
      if (parsed !== null) {
        need(
          parsed.documentation === owner.doc,
          `${owner.contract} points at ${JSON.stringify(parsed.documentation)}; want `
          + `${JSON.stringify(owner.doc)}.`,
        );
        need(
          source(world, owner.doc) !== null,
          `${owner.contract} points at ${owner.doc}, which does not exist. A contract that cannot `
          + `be explained is one the next author re-derives from its consumers.`,
        );
      }
    }
  }

  // No orphan. Every file in the tree is claimed by exactly one lane's filter,
  // evaluated with GitHub's own ordered semantics rather than by list
  // membership — an entry that a later negation takes back out is present in
  // the list and owns nothing.
  const laneFilters = [...LANE_FILTERS.keys()]
    .map((lane) => [lane, wPaths(world, lane)]);
  for (const file of treeFiles(world)) {
    const owners = laneFilters
      .filter(([, filter]) => filterStarts(filter, [file]))
      .map(([lane]) => lane)
      .sort();
    need(
      owners.length === 1,
      `${file} is started by ${owners.length} contract lane(s) [${owners.join(", ")}]; want exactly `
      + `one. While ${CONTRACTS}'s filter was \`${CONTRACT_TREE}/**\` the tree could not hold an `
      + `unowned file; ownership is per DOCUMENT now, so a contract added with no lane is judged by `
      + `nothing until somebody happens to touch a consumer tree — and two lanes for one file is `
      + `two runners for one answer.`,
    );
  }

  for (const consumer of CONSUMERS) {
    const text = source(world, consumer.test);
    need(
      text !== null,
      `the ${consumer.language} consumer test ${consumer.test} does not exist, so ${consumer.lane}'s `
      + `${consumer.contractJob} job runs a selector that matches nothing — which most test `
      + `runners report as success.`,
    );
    // The claim that this file reads the contract is PROVED, not repeated. A
    // test that quietly stopped opening the document would leave a lane
    // charging a runner for a file nobody reads.
    need(
      text === null || text.includes(consumer.contract),
      `${consumer.test} does not name ${consumer.contract} verbatim. This policy, ${consumer.lane}'s `
      + `filter and the whole ownership argument rest on that file being an INPUT to this test; if `
      + `it is not, the lane is cost with no answer attached.`,
    );
  }
  return out;
}

// ── 2. a contract edit starts its own lane, and nothing heavy ───────────────

function triggerFailures(world) {
  const out = [];
  const need = (ok, message) => { if (!ok) out.push(message); };

  for (const owner of OWNERSHIP) {
    const files = [owner.contract];
    need(
      filterStarts(wPaths(world, owner.lane), files),
      `a change to ${owner.contract} does NOT start ${owner.lane} `
      + `(filter ${JSON.stringify(wPaths(world, owner.lane))}). That document would then be judged `
      + `by no workflow at all until somebody happened to touch a consumer tree.`,
    );
    for (const heavy of HEAVY_LANES) {
      need(
        !filterStarts(wPaths(world, heavy), files),
        `a change confined to ${owner.contract} starts ${heavy} `
        + `(filter ${JSON.stringify(wPaths(world, heavy))}). That lane opens no file under `
        + `${CONTRACT_TREE}/: it is a paid macOS runner, a signing identity, a browser matrix or `
        + `an eight-shard race lane charged for a JSON document. The contract lanes exist so it `
        + `does not have to be.`,
      );
    }
    // The OTHER tree's lane must stay out of it. This is the cost the split was
    // argued about: a deploy-contract edit that started `contracts.yml` would
    // take a PAID macOS runner and an `npm ci` to re-run two jobs that cannot
    // open the document.
    for (const other of OWNERSHIP) {
      if (other.lane === owner.lane) continue;
      need(
        !filterStarts(wPaths(world, other.lane), files),
        `a change confined to ${owner.contract} also starts ${other.lane}, whose jobs are `
        + `[${other.consumers.map((c) => c.contractJob).join(", ")}] and which opens `
        + `${other.contract}, not this one`
        + `${other.consumers.some((c) => c.paidRunner) ? " — including a PAID macOS runner" : ""}.`,
      );
    }
    // The two always-on gates carry no filter at all, which is what makes them
    // impossible to route around — including by a future contract.
    for (const always of [COMPAT, HYGIENE]) {
      need(
        wPaths(world, always) === null,
        `${always} has grown a push path filter, so it is no longer always-on and a contract-only `
        + `edit can now miss it.`,
      );
      need(
        filterStarts(wPaths(world, always), files),
        `a change to ${owner.contract} does not start ${always}`,
      );
    }

    // A lane must not be started by trees it cannot judge. Its filter is its own
    // document plus its own file, and a wider entry is a cheap lane growing into
    // an always-on one nobody costed.
    const paths = wPaths(world, owner.lane);
    need(
      deepEqual(paths, LANE_FILTERS.get(owner.lane)),
      `${owner.lane}'s path filter is ${JSON.stringify(paths)}; want exactly `
      + `${JSON.stringify(LANE_FILTERS.get(owner.lane))}. Two entries and no exclusion: the `
      + `document it owns, and itself. \`${CONTRACT_TREE}/**\` here is what put a Swift runner on `
      + `a document Swift never opens.`,
    );
    need(
      deepEqual(paths, world.docs.get(owner.lane)?.on?.pull_request?.paths ?? null),
      `${owner.lane}'s push and pull_request filters differ. The two lists are aliased from one `
      + `anchor precisely so they cannot: a lane that is narrower on pull_request passes on the `
      + `branch and is simply not run after the merge.`,
    );

    // And the other direction: an ordinary source change must NOT start it.
    for (const consumer of CONSUMERS) {
      need(
        !filterStarts(paths, [consumer.test]),
        `editing ${consumer.test} starts ${owner.lane} as well as ${consumer.workflow}. That is two `
        + `lanes for one answer — and for Swift, two PAID macOS runners — because `
        + `${consumer.workflow} already executes this test.`,
      );
    }
  }
  return out;
}

// ── 3. the owning suites still run the consumer tests ───────────────────────
//
// The cheap lanes are only defensible while the ordinary path is intact. If
// `go.yml` stopped running `go test ./...`, or `web.yml` its suite, a consumer
// test would live in a tree whose workflow no longer executes it, and a source
// change that broke the contract would land green.

function owningSuiteFailures(world) {
  const out = [];
  const need = (ok, message) => { if (!ok) out.push(message); };

  for (const consumer of CONSUMERS) {
    need(
      filterStarts(wPaths(world, consumer.workflow), [consumer.test]),
      `editing ${consumer.test} does not start ${consumer.workflow}, which is the workflow that `
      + `owns its tree. The ${consumer.language} consumer test would then run only when the `
      + `contract itself changed — never when the code it compares the contract to did.`,
    );
    const doc = world.docs.get(consumer.workflow);
    const runsIt = Object.values(doc?.jobs ?? {}).some((job) =>
      realRunLines(job).some((line) => line.includes(consumer.runs)));
    need(
      runsIt,
      `${consumer.workflow} no longer runs \`${consumer.runs}\`, so it starts for a change to `
      + `${consumer.test} and then does not execute it.`,
    );
  }
  return out;
}

// ── 4. what the contract lanes may cost ─────────────────────────────────────

function laneFailures(world) {
  const out = [];
  const need = (ok, message) => { if (!ok) out.push(message); };

  for (const owner of OWNERSHIP) {
    const lane = owner.lane;
    const doc = world.docs.get(lane);
    need(doc !== undefined, `${lane} is missing or did not parse.`);
    if (doc === undefined) continue;

    const text = world.texts.get(lane) ?? "";

    // 4a. No secret, no signing identity, no artifact, no retry. These lanes
    //     read a document and compare it to an implementation: they publish
    //     nothing and have no identity to borrow, so anything in this list is
    //     either dead weight or a release path growing in a cheap workflow.
    for (const [pattern, what] of [
      [/secrets\./, "reads a repository secret"],
      [/upload-artifact|download-artifact/, "uploads or downloads a build artifact"],
      [/codesign|notarytool|productsign|xcrun\s+altool|softwareupdate/,
        "signs, notarizes or mutates the runner's system state"],
      [/\bretry\b|\bretries\b/i, "retries"],
    ]) {
      need(
        !pattern.test(text),
        `${lane} ${what} (matched ${pattern}). This lane judges a JSON document against its `
        + `implementations. Anything in that list is either a release path growing in the cheapest `
        + `workflow to edit, or something intermittent being smoothed over on a gate whose whole `
        + `job is to be deterministic.`,
      );
    }
    need(
      doc.permissions?.contents === "read" && Object.keys(doc.permissions ?? {}).length === 1,
      `${lane} declares permissions ${JSON.stringify(doc.permissions)}; want exactly `
      + `{contents: read}. A read-only token is what makes "this lane publishes nothing" a property `
      + `of the workflow rather than of its current steps.`,
    );

    // 4b. Exactly one job per consumer, each running exactly the smallest owning
    //     command, from the right directory, fail-closed and finite.
    const wantJobs = owner.consumers.map((c) => c.contractJob).sort();
    const jobNames = Object.keys(doc.jobs ?? {}).sort();
    need(
      deepEqual(jobNames, wantJobs),
      `${lane} declares jobs [${jobNames.join(", ")}]; want exactly [${wantJobs.join(", ")}] — one `
      + `per implementation that parses ${owner.contract}. An extra job here is work nobody costed `
      + `on a lane that starts on every edit to that document.`,
    );

    for (const consumer of owner.consumers) {
      const job = doc.jobs?.[consumer.contractJob];
      if (job === undefined) {
        need(false, `${lane} declares no job ${consumer.contractJob}`);
        continue;
      }
      const step = (job.steps ?? []).find((s) => String(s?.run ?? "").includes(consumer.contractCommand));
      need(
        step !== undefined,
        `${lane}/${consumer.contractJob} does not run \`${consumer.contractCommand}\`. That exact `
        + `command is the SMALLEST one that judges the ${consumer.language} half: a broader one `
        + `re-runs a suite ${consumer.workflow} already owns, on a lane started by every edit to `
        + `${owner.contract}.`,
      );
      if (step !== undefined) {
        need(
          step["working-directory"] === consumer.workingDirectory,
          `${lane}/${consumer.contractJob} runs its command from `
          + `${JSON.stringify(step["working-directory"])}; want `
          + `${JSON.stringify(consumer.workingDirectory)}, which is where its toolchain resolves `
          + `the project.`,
        );
      }
      const timeout = Number(job["timeout-minutes"]);
      need(
        Number.isFinite(timeout) && timeout > 0,
        `${lane}/${consumer.contractJob}: timeout-minutes is `
        + `${JSON.stringify(job["timeout-minutes"])}, want a finite positive number. Undeclared, a `
        + `job inherits GitHub's SIX-HOUR default — and this one holds a `
        + `${String(job["runs-on"])} runner.`,
      );
      need(
        job.if === undefined,
        `${lane}/${consumer.contractJob}: a job-level "if:" lets this check skip itself, and a `
        + `skipped check reports NOTHING rather than red.`,
      );
      need(
        job["continue-on-error"] === undefined,
        `${lane}/${consumer.contractJob}: continue-on-error makes the only run of the `
        + `${consumer.language} contract check advisory.`,
      );
      need(
        realRunLines(job).length > 0,
        `${lane}/${consumer.contractJob}: every run line is an echo or a no-op, so it reports `
        + `green for a comparison nobody made.`,
      );
      const swallows = realRunLines(job).find((line) => /\|\|\s*(true|:|echo|exit 0)/.test(line));
      need(
        swallows === undefined,
        `${lane}/${consumer.contractJob}: a command swallows its own exit status `
        + `(${JSON.stringify(swallows ?? "")}), so the job reports green after the comparison failed.`,
      );
      for (const s of job.steps ?? []) {
        need(
          s.if === undefined,
          `${lane}/${consumer.contractJob}: a step sets "if:", and a check that can skip itself `
          + `is not a check.`,
        );
        need(
          s["continue-on-error"] === undefined,
          `${lane}/${consumer.contractJob}: a step sets continue-on-error.`,
        );
      }
    }

    // 4c. A PAID runner only where the consumer table says one is unavoidable.
    //     This is the cost the whole design was arguing about; leaving it
    //     unasserted is how the free jobs quietly move to macOS for a toolchain
    //     convenience — and it is what keeps the deploy-contract lane, whose
    //     table declares NO paid consumer, on Ubuntu forever.
    for (const [name, job] of Object.entries(doc.jobs ?? {})) {
      const paid = String(job["runs-on"] ?? "").startsWith("macos");
      const wantPaid = owner.consumers.some((c) => c.contractJob === name && c.paidRunner);
      need(
        paid === wantPaid,
        `${lane}/${name} runs on ${JSON.stringify(job["runs-on"])}, and its consumer entry says `
        + `paidRunner=${wantPaid}. A job may hold a PAID macOS runner only where no other runner `
        + `can build its implementation.`,
      );
    }
  }

  // 4d. Both declarative policies are themselves executed, in the one workflow
  //     that cannot be filtered away.
  const hygiene = world.docs.get(HYGIENE);
  need(
    wPaths(world, HYGIENE) === null,
    `${HYGIENE} has grown a path filter, so these policies no longer run on every commit.`,
  );
  for (const self of SELF_TESTS) {
    const command = `node ${self.test}`;
    const hosts = Object.entries(hygiene?.jobs ?? {})
      .filter(([, job]) => realRunLines(job).some((line) => line.includes(command)));
    need(
      hosts.length > 0,
      `no job in ${HYGIENE} runs \`${command}\`. ${HYGIENE} carries no path filter, which is the `
      + `only place a rule about which workflows a contract edit starts — and, for the deploy `
      + `contract, whether a product path it names still exists — can be checked on a commit that `
      + `starts none of the filtered lanes.`,
    );
    need(
      source(world, self.test) !== null,
      `${self.test} does not exist, but ${HYGIENE} is required to run it.`,
    );
    for (const [name, job] of hosts) {
      const timeout = Number(job["timeout-minutes"]);
      need(
        Number.isFinite(timeout) && timeout > 0 && timeout <= self.timeoutMax,
        `${HYGIENE}/${name} hosts ${self.test} with timeout-minutes `
        + `${JSON.stringify(job["timeout-minutes"])}; want a finite number no greater than `
        + `${self.timeoutMax}.`,
      );
    }
  }
  return out;
}

// ── 5. the proof that every rule above can still fail ───────────────────────
//
// Each case breaks ONE property in a copy of the real world and requires the
// matching complaint BY ITS OWN WORDING. "Something failed" would also be
// satisfied by a broken parser or an unrelated typo.

function clone(world) {
  return {
    texts: new Map(world.texts),
    docs: new Map([...world.texts].map(([name, text]) => [name, parseYaml(text)])),
    sources: new Map(world.sources),
    treeFiles: [...world.treeFiles],
  };
}

function withPaths(world, file, paths) {
  const on = world.docs.get(file).on;
  on.push.paths = paths;
  on.pull_request = { ...(on.pull_request ?? {}), paths };
  return world;
}

/** Mutate the job in `file` that runs `command`, and the step carrying it. */
function withCommandJob(world, file, command, mutate) {
  for (const [name, job] of Object.entries(world.docs.get(file)?.jobs ?? {})) {
    const step = (job.steps ?? []).find((s) => String(s?.run ?? "").includes(command));
    if (step) { mutate(job, step, name); return world; }
  }
  throw new Error(`no job in ${file} runs ${command}`);
}

const DEVICE_INBOX = OWNERSHIP[0];
const OPS_CONTRACT = OWNERSHIP[1];

const MUTATIONS = [
  // ── ownership ─────────────────────────────────────────────────────────────
  {
    name: "a consumer test stops reading the contract it is named for",
    mutate: (w) => {
      w.sources.set(CONSUMERS[0].test, "package account\n// nothing here opens a document\n");
      return w;
    },
    expect: /does not name contracts\/device-inbox-admission-v1\.json verbatim/,
  },
  {
    name: "the deploy contract's Go consumer stops reading it",
    mutate: (w) => {
      w.sources.set(OPS_CONTRACT.consumers[0].test, "package main\n// nothing here opens a document\n");
      return w;
    },
    expect: /does not name contracts\/ops-deploy-v1\.json verbatim/,
  },
  {
    name: "a contract stops pointing at a document that exists",
    mutate: (w) => {
      const parsed = JSON.parse(source(w, OPS_CONTRACT.contract));
      parsed.documentation = "docs/NO-SUCH-DOCUMENT.md";
      w.sources.set(OPS_CONTRACT.contract, JSON.stringify(parsed));
      return w;
    },
    expect: /points at "docs\/NO-SUCH-DOCUMENT\.md"; want/,
  },
  {
    // The state the tree-wide filter used to make impossible: a third contract
    // lands, no lane names it, every workflow stays valid, and it is judged by
    // nothing.
    name: "a third contract lands in the tree with no lane naming it",
    mutate: (w) => {
      w.treeFiles = [...w.treeFiles, `${CONTRACT_TREE}/relay-node-registration-v1.json`].sort();
      return w;
    },
    expect: /relay-node-registration-v1\.json is started by 0 contract lane\(s\) \[\]; want exactly one/,
  },
  {
    // And the other side of the same rule: the old tree-wide filter, restored,
    // now means two lanes answer for one file.
    name: "the Device Inbox lane goes back to owning the whole tree",
    mutate: (w) => withPaths(w, CONTRACTS,
      [`${CONTRACT_TREE}/**`, `.github/workflows/${CONTRACTS}`]),
    expect: /ops-deploy-v1\.json is started by 2 contract lane\(s\) \[contracts\.yml, ops-deploy-contract\.yml\]/,
  },

  // ── the trigger boundary ──────────────────────────────────────────────────
  {
    // The rule the whole design turns on, applied literally: naming a document
    // in the consumer's filter starts an eight-shard race lane on a JSON edit.
    name: "go.yml names a contract in its own filter",
    mutate: (w) => withPaths(w, GO, [...wPaths(w, GO), DEVICE_INBOX.contract]),
    expect: /starts go\.yml \(filter .*device-inbox-admission-v1\.json/,
  },
  {
    name: "web.yml names the whole contract tree in its own filter",
    mutate: (w) => withPaths(w, WEB, [...wPaths(w, WEB), `${CONTRACT_TREE}/**`]),
    expect: /starts web\.yml \(filter .*contracts\/\*\*/,
  },
  {
    // The cost the split was argued about: an ops-contract edit reaching the
    // three-consumer lane and taking a PAID macOS runner for a document Swift
    // never opens.
    name: "the deploy contract is added to the three-consumer lane's filter",
    mutate: (w) => withPaths(w, CONTRACTS,
      [DEVICE_INBOX.contract, OPS_CONTRACT.contract, `.github/workflows/${CONTRACTS}`]),
    expect: /a change confined to contracts\/ops-deploy-v1\.json also starts contracts\.yml.*PAID macOS runner/s,
  },
  {
    // Invisible to list membership and to YAML validity: the entry is present,
    // and a later negation takes it back out.
    name: "the deploy lane's own filter excludes the document it owns",
    mutate: (w) => withPaths(w, OPS_DEPLOY,
      [...LANE_FILTERS.get(OPS_DEPLOY), `!${CONTRACT_TREE}/**`]),
    expect: /does NOT start ops-deploy-contract\.yml/,
  },
  {
    name: "the deploy lane's filter grows an entry nobody costed",
    mutate: (w) => withPaths(w, OPS_DEPLOY, [...LANE_FILTERS.get(OPS_DEPLOY), "server/**"]),
    expect: /ops-deploy-contract\.yml's path filter is .*server\/\*\*.*want exactly/s,
  },
  {
    name: "the deploy lane is narrower on pull_request than on push",
    mutate: (w) => {
      w.docs.get(OPS_DEPLOY).on.pull_request.paths = [`.github/workflows/${OPS_DEPLOY}`];
      return w;
    },
    expect: /ops-deploy-contract\.yml's push and pull_request filters differ/,
  },
  {
    name: "the always-on compat gate grows a path filter",
    mutate: (w) => {
      w.docs.get(COMPAT).on.push.paths = ["web/**"];
      return w;
    },
    expect: /compat\.yml has grown a push path filter/,
  },

  // ── the owning suites ─────────────────────────────────────────────────────
  {
    name: "web.yml stops running the suite that contains its consumer test",
    mutate: (w) => {
      for (const job of Object.values(w.docs.get(WEB).jobs ?? {})) {
        for (const step of job.steps ?? []) {
          if (String(step.run ?? "").includes("npm test")) step.run = "npm run build\n";
        }
      }
      return w;
    },
    expect: /web\.yml no longer runs `npm test`/,
  },
  {
    name: "swift-package.yml stops running the package suite",
    mutate: (w) => withCommandJob(w, SWIFT_PACKAGE, "swift test", (job, step) => {
      step.run = "swift build\n";
    }),
    expect: /swift-package\.yml no longer runs `swift test`/,
  },
  {
    // The deploy contract's Go consumer lives under `server/**`, so `go.yml` is
    // what runs it on an ordinary server change. Break that and a server edit
    // can invalidate the frozen health surface and land green.
    name: "go.yml stops running the suite that contains both Go consumer tests",
    mutate: (w) => withCommandJob(w, GO, "go test ./...", (job, step) => {
      step.run = "go build ./...\n";
    }),
    expect: /go\.yml no longer runs `go test \.\/\.\.\.`/,
  },

  // ── what the lanes cost ───────────────────────────────────────────────────
  {
    name: "the Go contract job widens to the whole server suite",
    mutate: (w) => withCommandJob(w, CONTRACTS, "go test ./account/", (job, step) => {
      step.run = "go test ./...\n";
    }),
    expect: /contracts\.yml\/go-contract does not run `go test \.\/account\//,
  },
  {
    name: "the deploy contract job widens to the whole root package",
    mutate: (w) => withCommandJob(w, OPS_DEPLOY, "-run '^TestOpsDeployContract'", (job, step) => {
      step.run = "go test ./ -count=1\n";
    }),
    expect: /ops-deploy-contract\.yml\/go-contract does not run `go test \.\/ -run/,
  },
  {
    name: "the Web contract job widens to the whole Vitest suite",
    mutate: (w) => withCommandJob(w, CONTRACTS, "npx vitest run", (job, step) => {
      step.run = "npm test -- --run\n";
    }),
    expect: /contracts\.yml\/web-contract does not run `npx vitest run/,
  },
  {
    name: "a contract job loses its timeout and inherits the six-hour default",
    mutate: (w) => withCommandJob(w, CONTRACTS, "swift test", (job) => {
      delete job["timeout-minutes"];
    }),
    expect: /contracts\.yml\/swift-contract: timeout-minutes is undefined/,
  },
  {
    name: "the deploy contract job loses its timeout",
    mutate: (w) => withCommandJob(w, OPS_DEPLOY, "-run '^TestOpsDeployContract'", (job) => {
      delete job["timeout-minutes"];
    }),
    expect: /ops-deploy-contract\.yml\/go-contract: timeout-minutes is undefined/,
  },
  {
    name: "a contract job swallows its own exit status",
    mutate: (w) => withCommandJob(w, OPS_DEPLOY, "-run '^TestOpsDeployContract'", (job, step) => {
      step.run = `${String(step.run).trim()} || true\n`;
    }),
    expect: /ops-deploy-contract\.yml\/go-contract: a command swallows its own exit status/,
  },
  {
    name: "a contract job is made advisory",
    mutate: (w) => withCommandJob(w, CONTRACTS, "npx vitest run", (job) => {
      job["continue-on-error"] = true;
    }),
    expect: /contracts\.yml\/web-contract: continue-on-error/,
  },
  {
    name: "a contract job gains a condition it can skip itself with",
    mutate: (w) => withCommandJob(w, OPS_DEPLOY, "-run '^TestOpsDeployContract'", (job) => {
      job.if = "github.event_name == 'push'";
    }),
    expect: /ops-deploy-contract\.yml\/go-contract: a job-level "if:"/,
  },
  {
    name: "the cheap ubuntu half moves onto a paid macOS runner",
    mutate: (w) => withCommandJob(w, CONTRACTS, "go test ./account/", (job) => {
      job["runs-on"] = "macos-15";
    }),
    expect: /contracts\.yml\/go-contract runs on "macos-15", and its consumer entry says paidRunner=false/,
  },
  {
    // The deploy lane has NO paid consumer at all, so this is the direction its
    // ubuntu-only claim decays in.
    name: "the deploy lane takes a paid macOS runner",
    mutate: (w) => withCommandJob(w, OPS_DEPLOY, "-run '^TestOpsDeployContract'", (job) => {
      job["runs-on"] = "macos-15";
    }),
    expect: /ops-deploy-contract\.yml\/go-contract runs on "macos-15", and its consumer entry says paidRunner=false/,
  },
  {
    name: "a lane gains a job nobody costed",
    mutate: (w) => {
      w.docs.get(OPS_DEPLOY).jobs.publish = {
        "runs-on": "ubuntu-latest", "timeout-minutes": 5, steps: [{ run: "echo publish\n" }],
      };
      return w;
    },
    expect: /ops-deploy-contract\.yml declares jobs \[.*publish.*\]; want exactly/,
  },
  {
    name: "a lane's permissions widen past read",
    mutate: (w) => {
      w.docs.get(OPS_DEPLOY).permissions = { contents: "write" };
      return w;
    },
    expect: /ops-deploy-contract\.yml declares permissions .*"write".*want exactly/s,
  },
  {
    name: "a lane grows a secret",
    mutate: (w) => {
      w.texts.set(OPS_DEPLOY, `${w.texts.get(OPS_DEPLOY)}\n          token: \${{ secrets.GH_TOKEN }}\n`);
      return w;
    },
    expect: /ops-deploy-contract\.yml reads a repository secret/,
  },
  {
    name: "this policy stops being executed by the unfiltered workflow",
    mutate: (w) => {
      for (const job of Object.values(w.docs.get(HYGIENE).jobs ?? {})) {
        for (const step of job.steps ?? []) {
          if (String(step.run ?? "").includes(SELF_TESTS[0].test)) step.run = "echo skipped\n";
        }
      }
      return w;
    },
    expect: new RegExp(`no job in ${HYGIENE.replace(".", "\\.")} runs \`node ${SELF_TESTS[0].test.replace(/[.\/]/g, "\\$&")}\``),
  },
  {
    // The deploy contract's always-on half. Losing it is the quiet one: the
    // filtered lane still reports green on contract edits, and the check that a
    // declared product path still exists simply stops running.
    name: "the deploy contract's always-on filesystem policy stops being executed",
    mutate: (w) => {
      for (const job of Object.values(w.docs.get(HYGIENE).jobs ?? {})) {
        for (const step of job.steps ?? []) {
          if (String(step.run ?? "").includes(SELF_TESTS[1].test)) step.run = "echo skipped\n";
        }
      }
      return w;
    },
    expect: new RegExp(`no job in ${HYGIENE.replace(".", "\\.")} runs \`node ${SELF_TESTS[1].test.replace(/[.\/]/g, "\\$&")}\``),
  },
  {
    name: "an always-on policy is hosted with an unbounded timeout",
    mutate: (w) => {
      for (const [, job] of Object.entries(w.docs.get(HYGIENE).jobs ?? {})) {
        if (!realRunLines(job).some((line) => line.includes(SELF_TESTS[1].test))) continue;
        delete job["timeout-minutes"];
      }
      return w;
    },
    expect: /hosts scripts\/test\/ops-deploy-contract-test\.mjs with timeout-minutes undefined/,
  },
];

// ── run ─────────────────────────────────────────────────────────────────────

const RULES = [ownershipFailures, triggerFailures, owningSuiteFailures, laneFailures];
const judge = (world) => RULES.flatMap((rule) => rule(world));

const world = loadWorld();
// Warm the source cache so a mutation can replace a file the rules will read.
for (const owner of OWNERSHIP) {
  source(world, owner.contract);
  source(world, owner.doc);
}
for (const consumer of CONSUMERS) source(world, consumer.test);
for (const self of SELF_TESTS) source(world, self.test);

for (const message of judge(world)) check(false, message);

let mutationsProven = 0;
for (const mutation of MUTATIONS) {
  let messages;
  try {
    messages = judge(mutation.mutate(clone(world)));
  } catch (error) {
    check(false, `the mutation "${mutation.name}" could not be applied: ${error.message}. A `
      + `mutation that stopped applying leaves the world unbroken and its case passes while `
      + `asserting nothing.`);
    continue;
  }
  if (messages.some((message) => mutation.expect.test(message))) {
    mutationsProven++;
    continue;
  }
  check(false, `the contract CI policy did NOT complain about "${mutation.name}". Expected a `
    + `message matching ${mutation.expect}; got [\n    ${messages.join("\n    ") || "nothing"}\n  ]. `
    + `A check that cannot fail for the reason it was written is not a check.`);
}

if (failures.length > 0) {
  console.error("contract-ci-policy-test: FAILED\n");
  for (const failure of failures) console.error(`  ✗ ${failure}\n`);
  process.exit(1);
}

console.log(
  `contract-ci-policy-test: OK (${OWNERSHIP.length} contracts in ${CONTRACT_TREE}/, each owned by `
  + `exactly one of [${[...LANE_FILTERS.keys()].join(", ")}] over ${CONSUMERS.length} finite, `
  + `secret-free jobs — one PAID macOS runner, ${CONSUMERS.length - 1} ubuntu — while `
  + `${HEAVY_LANES.join(", ")} stay out of a document edit and still own their own consumer tests; `
  + `${world.treeFiles.length} tree files checked for an owner; ordered last-match-wins path `
  + `semantics compiled and proved; ${mutationsProven} mutations prove each rule can fail)`,
);
