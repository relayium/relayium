#!/usr/bin/env node
// scripts/test/contract-ci-policy-test.mjs — who owns `contracts/`, what a
// contract-only edit is allowed to start, and what the lane that judges it may
// cost.
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
// So the tree got a lane of its own, `contracts.yml`, running the three smallest
// commands that judge the three implementations. That decision has two halves
// and this file asserts both, because either alone is a regression:
//
//   * a contract-only edit starts `contracts.yml` and the two ALWAYS-ON gates,
//     and starts none of the heavy product lanes;
//   * an ordinary Go, Web or Swift source change still starts its own owning
//     suite, and that suite still EXECUTES the consumer test.
//
// Drop the first and a document edit costs a paid macOS signing lane. Drop the
// second and the consumer tests exist in trees whose suites no longer run them,
// which is the same green-board-over-nothing shape with an extra file.
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
const CONTRACT_FILE = "contracts/device-inbox-admission-v1.json";
const CONTRACT_DOC = "docs/DEVICE-INBOX-ADMISSION-CONTRACT.md";

const CONTRACTS = "contracts.yml";
const GO = "go.yml";
const WEB = "web.yml";
const SWIFT_PACKAGE = "swift-package.yml";
const COMPAT = "compat.yml";
const HYGIENE = "repo-hygiene.yml";

/** The lanes a document edit must never start. Each is a paid runner, a signing
 *  identity, a browser matrix or an eight-shard race — and not one of them opens
 *  the contract. */
const HEAVY_LANES = ["macos.yml", "ios.yml", "native-web-pairing.yml", GO, WEB];

/** This file, and the unfiltered workflow that has to execute it. */
const SELF_TEST = "scripts/test/contract-ci-policy-test.mjs";
const SELF_COMMAND = `node ${SELF_TEST}`;
/** Minutes. This parses a handful of small YAML documents and reads four files. */
const SELF_TIMEOUT_MAX = 5;

/**
 * The three consumers, the workflow that owns each for an ORDINARY source
 * change, and the command in that workflow which actually executes it.
 *
 * `runs` is checked against the workflow's real steps, not assumed: a suite that
 * stopped running the file its tree owns is the failure this column exists for.
 */
const CONSUMERS = [
  {
    language: "Go",
    test: "server/account/deviceinbox_admission_contract_test.go",
    workflow: GO,
    runs: "go test ./...",
    contractJob: "go-contract",
    contractCommand: "go test ./account/ -run '^TestDeviceInboxAdmissionContract' -count=1",
    workingDirectory: "server",
  },
  {
    language: "Web",
    test: "web/src/lib/device-inbox-admission-contract.test.ts",
    workflow: WEB,
    runs: "npm test",
    contractJob: "web-contract",
    contractCommand: "npx vitest run src/lib/device-inbox-admission-contract.test.ts",
    workingDirectory: "web",
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
  },
];

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
  return { texts, docs, sources: new Map() };
}

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

// ── 1. the tree exists, and its consumers really read it ────────────────────
//
// Everything below is a claim about a document three tests open. If the document
// is gone, or a test stopped naming it, every ownership rule is reasoning about
// a file nobody reads — the direction that decays without anyone editing a
// workflow.

function ownershipFailures(world) {
  const out = [];
  const need = (ok, message) => { if (!ok) out.push(message); };

  const contract = source(world, CONTRACT_FILE);
  need(
    contract !== null,
    `${CONTRACT_FILE} does not exist, but ${CONTRACTS} exists to run three tests against it and `
    + `this policy exists to bound what that costs. A lane whose subject is gone reports green `
    + `over nothing.`,
  );
  if (contract !== null) {
    let parsed = null;
    try { parsed = JSON.parse(contract); } catch (error) {
      need(false, `${CONTRACT_FILE} is not valid JSON: ${error.message}`);
    }
    if (parsed !== null) {
      need(
        parsed.documentation === CONTRACT_DOC,
        `${CONTRACT_FILE} points at ${JSON.stringify(parsed.documentation)}; want `
        + `${JSON.stringify(CONTRACT_DOC)}.`,
      );
      need(
        source(world, CONTRACT_DOC) !== null,
        `${CONTRACT_FILE} points at ${CONTRACT_DOC}, which does not exist. A contract that cannot `
        + `be explained is one the next author re-derives from three test files.`,
      );
    }
  }

  for (const consumer of CONSUMERS) {
    const text = source(world, consumer.test);
    need(
      text !== null,
      `the ${consumer.language} consumer test ${consumer.test} does not exist, so ${CONTRACTS}'s `
      + `${consumer.contractJob} job runs a selector that matches nothing — which most test `
      + `runners report as success.`,
    );
    // The claim that this file reads the contract is PROVED, not repeated. A
    // test that quietly stopped opening the document would leave a lane
    // charging three runners for a file nobody reads.
    need(
      text === null || text.includes(CONTRACT_FILE),
      `${consumer.test} does not name ${CONTRACT_FILE} verbatim. This policy, `
      + `${CONTRACTS}'s filter and the whole ownership argument rest on that file being an INPUT `
      + `to this test; if it is not, the lane is cost with no answer attached.`,
    );
  }
  return out;
}

// ── 2. a contract-only edit starts the cheap lane, and nothing heavy ────────

function triggerFailures(world) {
  const out = [];
  const need = (ok, message) => { if (!ok) out.push(message); };

  const edits = [
    [CONTRACT_FILE],
    [`${CONTRACT_TREE}/some-future-contract-v1.json`],
    [CONTRACT_FILE, `${CONTRACT_TREE}/nested/another.json`],
  ];

  for (const files of edits) {
    need(
      filterStarts(wPaths(world, CONTRACTS), files),
      `a change to ${files.join(", ")} does NOT start ${CONTRACTS} `
      + `(filter ${JSON.stringify(wPaths(world, CONTRACTS))}). The contract tree would then be `
      + `judged by no workflow at all until somebody happened to touch server, web or the Swift `
      + `package.`,
    );
    for (const heavy of HEAVY_LANES) {
      need(
        !filterStarts(wPaths(world, heavy), files),
        `a change confined to ${files.join(", ")} starts ${heavy} `
        + `(filter ${JSON.stringify(wPaths(world, heavy))}). That lane opens no file under `
        + `${CONTRACT_TREE}/: it is a paid macOS runner, a signing identity, a browser matrix or `
        + `an eight-shard race lane charged for a JSON document. The contract lane exists so it `
        + `does not have to be.`,
      );
    }
    // The two always-on gates carry no filter at all, which is what makes them
    // impossible to route around — including by a future contract tree.
    for (const always of [COMPAT, HYGIENE]) {
      need(
        wPaths(world, always) === null,
        `${always} has grown a push path filter, so it is no longer always-on and a contract-only `
        + `edit can now miss it.`,
      );
      need(
        filterStarts(wPaths(world, always), files),
        `a change to ${files.join(", ")} does not start ${always}`,
      );
    }
  }

  // The contract lane must not be started by trees it cannot judge. Its filter
  // is the tree plus its own file, and a wider entry is a cheap lane growing
  // into an always-on one nobody costed.
  const paths = wPaths(world, CONTRACTS);
  need(
    deepEqual(paths, [`${CONTRACT_TREE}/**`, `.github/workflows/${CONTRACTS}`]),
    `${CONTRACTS}'s path filter is ${JSON.stringify(paths)}; want exactly `
    + `["${CONTRACT_TREE}/**", ".github/workflows/${CONTRACTS}"]. Two entries and no exclusion, `
    + `for the same reason ${SWIFT_PACKAGE} has two: this lane owns one tree and must see every `
    + `file in it, and an exclusion here would create a contract file with no owner at all.`,
  );
  need(
    deepEqual(paths, world.docs.get(CONTRACTS)?.on?.pull_request?.paths ?? null),
    `${CONTRACTS}'s push and pull_request filters differ. The two lists are aliased from one `
    + `anchor precisely so they cannot: a lane that is narrower on pull_request passes on the `
    + `branch and is simply not run after the merge.`,
  );

  // And the other direction: an ordinary source change must NOT start this lane.
  for (const consumer of CONSUMERS) {
    need(
      !filterStarts(paths, [consumer.test]),
      `editing ${consumer.test} starts ${CONTRACTS} as well as ${consumer.workflow}. That is two `
      + `lanes for one answer — and for Swift, two PAID macOS runners — because `
      + `${consumer.workflow} already executes this test.`,
    );
  }
  return out;
}

// ── 3. the owning suites still run the consumer tests ───────────────────────
//
// The cheap lane is only defensible while the ordinary path is intact. If
// `go.yml` stopped running `go test ./...`, or `web.yml` its suite, the consumer
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

// ── 4. what the contract lane may cost ──────────────────────────────────────

function laneFailures(world) {
  const out = [];
  const need = (ok, message) => { if (!ok) out.push(message); };

  const doc = world.docs.get(CONTRACTS);
  need(doc !== undefined, `${CONTRACTS} is missing or did not parse.`);
  if (doc === undefined) return out;

  const text = world.texts.get(CONTRACTS) ?? "";

  // 4a. No secret, no signing identity, no artifact, no retry. This lane reads
  //     a document and compares it to three implementations: it publishes
  //     nothing and has no identity to borrow, so anything in this list is
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
      `${CONTRACTS} ${what} (matched ${pattern}). This lane judges a JSON document against three `
      + `implementations. Anything in that list is either a release path growing in the cheapest `
      + `workflow to edit, or something intermittent being smoothed over on a gate whose whole `
      + `job is to be deterministic.`,
    );
  }
  need(
    doc.permissions?.contents === "read" && Object.keys(doc.permissions ?? {}).length === 1,
    `${CONTRACTS} declares permissions ${JSON.stringify(doc.permissions)}; want exactly `
    + `{contents: read}. A read-only token is what makes "this lane publishes nothing" a property `
    + `of the workflow rather than of its current steps.`,
  );

  // 4b. Exactly the three jobs, each running exactly the smallest owning
  //     command, from the right directory, fail-closed and finite.
  const jobNames = Object.keys(doc.jobs ?? {}).sort();
  need(
    deepEqual(jobNames, CONSUMERS.map((c) => c.contractJob).sort()),
    `${CONTRACTS} declares jobs [${jobNames.join(", ")}]; want exactly `
    + `[${CONSUMERS.map((c) => c.contractJob).sort().join(", ")}] — one per implementation that `
    + `parses the contract. A fourth job here is work nobody costed on a lane that starts on `
    + `every document edit.`,
  );

  for (const consumer of CONSUMERS) {
    const job = doc.jobs?.[consumer.contractJob];
    if (job === undefined) {
      need(false, `${CONTRACTS} declares no job ${consumer.contractJob}`);
      continue;
    }
    const step = (job.steps ?? []).find((s) => String(s?.run ?? "").includes(consumer.contractCommand));
    need(
      step !== undefined,
      `${CONTRACTS}/${consumer.contractJob} does not run `
      + `\`${consumer.contractCommand}\`. That exact command is the SMALLEST one that judges the `
      + `${consumer.language} half: a broader one re-runs a suite ${consumer.workflow} already `
      + `owns, on a lane started by every document edit.`,
    );
    if (step !== undefined) {
      need(
        step["working-directory"] === consumer.workingDirectory,
        `${CONTRACTS}/${consumer.contractJob} runs its command from `
        + `${JSON.stringify(step["working-directory"])}; want `
        + `${JSON.stringify(consumer.workingDirectory)}, which is where its toolchain resolves `
        + `the project.`,
      );
    }
    const timeout = Number(job["timeout-minutes"]);
    need(
      Number.isFinite(timeout) && timeout > 0,
      `${CONTRACTS}/${consumer.contractJob}: timeout-minutes is `
      + `${JSON.stringify(job["timeout-minutes"])}, want a finite positive number. Undeclared, a `
      + `job inherits GitHub's SIX-HOUR default — and this one holds a `
      + `${String(job["runs-on"])} runner.`,
    );
    need(
      job.if === undefined,
      `${CONTRACTS}/${consumer.contractJob}: a job-level "if:" lets this check skip itself, and a `
      + `skipped check reports NOTHING rather than red.`,
    );
    need(
      job["continue-on-error"] === undefined,
      `${CONTRACTS}/${consumer.contractJob}: continue-on-error makes the only run of the `
      + `${consumer.language} contract check advisory.`,
    );
    need(
      realRunLines(job).length > 0,
      `${CONTRACTS}/${consumer.contractJob}: every run line is an echo or a no-op, so it reports `
      + `green for a comparison nobody made.`,
    );
    const swallows = realRunLines(job).find((line) => /\|\|\s*(true|:|echo|exit 0)/.test(line));
    need(
      swallows === undefined,
      `${CONTRACTS}/${consumer.contractJob}: a command swallows its own exit status `
      + `(${JSON.stringify(swallows ?? "")}), so the job reports green after the comparison failed.`,
    );
    for (const s of job.steps ?? []) {
      need(
        s.if === undefined,
        `${CONTRACTS}/${consumer.contractJob}: a step sets "if:", and a check that can skip itself `
        + `is not a check.`,
      );
      need(
        s["continue-on-error"] === undefined,
        `${CONTRACTS}/${consumer.contractJob}: a step sets continue-on-error.`,
      );
    }
  }

  // 4c. Only ONE job may be a paid runner, and it is the Swift one. This is the
  //     cost this whole design was arguing about; leaving it unasserted is how
  //     the other two quietly move to macOS for a toolchain convenience.
  for (const [name, job] of Object.entries(doc.jobs ?? {})) {
    const paid = String(job["runs-on"] ?? "").startsWith("macos");
    const wantPaid = name === "swift-contract";
    need(
      paid === wantPaid,
      `${CONTRACTS}/${name} runs on ${JSON.stringify(job["runs-on"])}. Exactly one job here may `
      + `hold a PAID macOS runner — the Swift one, because no other runner can build the package. `
      + `The Go and Web halves are ubuntu work and must stay there.`,
    );
  }

  // 4d. This policy is itself executed, in the one workflow that cannot be
  //     filtered away.
  const hygiene = world.docs.get(HYGIENE);
  const hosted = Object.values(hygiene?.jobs ?? {}).some((job) =>
    realRunLines(job).some((line) => line.includes(SELF_COMMAND)));
  need(
    hosted,
    `no job in ${HYGIENE} runs \`${SELF_COMMAND}\`. ${HYGIENE} carries no path filter, which is `
    + `the only place a rule about which workflows a contract edit starts can be checked on a `
    + `commit that starts none of them.`,
  );
  need(
    wPaths(world, HYGIENE) === null,
    `${HYGIENE} has grown a path filter, so this policy no longer runs on every commit.`,
  );
  for (const [name, job] of Object.entries(hygiene?.jobs ?? {})) {
    if (!realRunLines(job).some((line) => line.includes(SELF_COMMAND))) continue;
    const timeout = Number(job["timeout-minutes"]);
    need(
      Number.isFinite(timeout) && timeout > 0 && timeout <= SELF_TIMEOUT_MAX,
      `${HYGIENE}/${name} hosts this policy with timeout-minutes `
      + `${JSON.stringify(job["timeout-minutes"])}; want a finite number no greater than `
      + `${SELF_TIMEOUT_MAX}.`,
    );
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
    name: "the contract stops pointing at a document that exists",
    mutate: (w) => {
      const parsed = JSON.parse(source(w, CONTRACT_FILE));
      parsed.documentation = "docs/NO-SUCH-DOCUMENT.md";
      w.sources.set(CONTRACT_FILE, JSON.stringify(parsed));
      return w;
    },
    expect: /points at "docs\/NO-SUCH-DOCUMENT\.md"; want/,
  },

  // ── the trigger boundary ──────────────────────────────────────────────────
  {
    // The rule the whole design turns on, applied literally: naming the
    // document in the consumer's filter starts an eight-shard race lane on a
    // JSON edit.
    name: "go.yml names the contract in its own filter",
    mutate: (w) => withPaths(w, GO, [...wPaths(w, GO), CONTRACT_FILE]),
    expect: /starts go\.yml \(filter .*device-inbox-admission-v1\.json/,
  },
  {
    name: "web.yml names the whole contract tree in its own filter",
    mutate: (w) => withPaths(w, WEB, [...wPaths(w, WEB), `${CONTRACT_TREE}/**`]),
    expect: /starts web\.yml \(filter .*contracts\/\*\*/,
  },
  {
    // Invisible to list membership and to YAML validity: the entry is present,
    // and a later negation takes it back out.
    name: "the contract lane's own filter excludes the tree it owns",
    mutate: (w) => withPaths(w, CONTRACTS,
      [`${CONTRACT_TREE}/**`, `.github/workflows/${CONTRACTS}`, `!${CONTRACT_TREE}/**`]),
    expect: /does NOT start contracts\.yml/,
  },
  {
    name: "the contract lane's filter grows an entry nobody costed",
    mutate: (w) => withPaths(w, CONTRACTS,
      [`${CONTRACT_TREE}/**`, `.github/workflows/${CONTRACTS}`, "docs/**"]),
    expect: /contracts\.yml's path filter is .*docs\/\*\*.*want exactly/s,
  },
  {
    name: "the contract lane is narrower on pull_request than on push",
    mutate: (w) => {
      w.docs.get(CONTRACTS).on.pull_request.paths = [`.github/workflows/${CONTRACTS}`];
      return w;
    },
    expect: /contracts\.yml's push and pull_request filters differ/,
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

  // ── what the lane costs ───────────────────────────────────────────────────
  {
    name: "the Go contract job widens to the whole server suite",
    mutate: (w) => withCommandJob(w, CONTRACTS, "go test ./account/", (job, step) => {
      step.run = "go test ./...\n";
    }),
    expect: /contracts\.yml\/go-contract does not run `go test \.\/account\//,
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
    name: "a contract job swallows its own exit status",
    mutate: (w) => withCommandJob(w, CONTRACTS, "go test ./account/", (job, step) => {
      step.run = `${String(step.run).trim()} || true\n`;
    }),
    expect: /contracts\.yml\/go-contract: a command swallows its own exit status/,
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
    mutate: (w) => withCommandJob(w, CONTRACTS, "npx vitest run", (job) => {
      job.if = "github.event_name == 'push'";
    }),
    expect: /contracts\.yml\/web-contract: a job-level "if:"/,
  },
  {
    name: "the cheap ubuntu half moves onto a paid macOS runner",
    mutate: (w) => withCommandJob(w, CONTRACTS, "go test ./account/", (job) => {
      job["runs-on"] = "macos-15";
    }),
    expect: /contracts\.yml\/go-contract runs on "macos-15"/,
  },
  {
    name: "the lane gains a fourth job nobody costed",
    mutate: (w) => {
      w.docs.get(CONTRACTS).jobs.publish = {
        "runs-on": "ubuntu-latest", "timeout-minutes": 5, steps: [{ run: "echo publish\n" }],
      };
      return w;
    },
    expect: /contracts\.yml declares jobs \[.*publish.*\]; want exactly/,
  },
  {
    name: "the lane's permissions widen past read",
    mutate: (w) => {
      w.docs.get(CONTRACTS).permissions = { contents: "write" };
      return w;
    },
    expect: /contracts\.yml declares permissions .*"write".*want exactly/s,
  },
  {
    name: "the lane grows a secret",
    mutate: (w) => {
      w.texts.set(CONTRACTS, `${w.texts.get(CONTRACTS)}\n          token: \${{ secrets.GH_TOKEN }}\n`);
      return w;
    },
    expect: /contracts\.yml reads a repository secret/,
  },
  {
    name: "this policy stops being executed by the unfiltered workflow",
    mutate: (w) => {
      for (const job of Object.values(w.docs.get(HYGIENE).jobs ?? {})) {
        for (const step of job.steps ?? []) {
          if (String(step.run ?? "").includes(SELF_COMMAND)) step.run = "echo skipped\n";
        }
      }
      return w;
    },
    expect: new RegExp(`no job in ${HYGIENE.replace(".", "\\.")} runs`),
  },
];

// ── run ─────────────────────────────────────────────────────────────────────

const RULES = [ownershipFailures, triggerFailures, owningSuiteFailures, laneFailures];
const judge = (world) => RULES.flatMap((rule) => rule(world));

const world = loadWorld();
// Warm the source cache so a mutation can replace a file the rules will read.
source(world, CONTRACT_FILE);
source(world, CONTRACT_DOC);
for (const consumer of CONSUMERS) source(world, consumer.test);

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
  `contract-ci-policy-test: OK (${CONTRACTS} owns ${CONTRACT_TREE}/ in ${CONSUMERS.length} finite, `
  + `secret-free jobs — one PAID macOS runner, two ubuntu — while ${HEAVY_LANES.join(", ")} stay `
  + `out of a document edit and still own their own consumer tests; ordered last-match-wins path `
  + `semantics compiled and proved; ${mutationsProven} mutations prove each rule can fail)`,
);
