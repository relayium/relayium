#!/usr/bin/env node
// scripts/test/ios-physical-fixture-isolation-test.mjs — the physical
// acceptance fixture is named per run (and per phase), never the fixed name an
// earlier run left in a real device's Received folder.
//
// A real device keeps what it received and the product refuses a taken flat
// name, so a harness that always staged `Relayium product brief.txt` failed its
// second run — or "fixed" that by emptying the owner's Received folder. This
// control EXECUTES the rule rather than mirroring it:
//
//   * the product's `UITestMode.FixtureName` and the UI-test suites'
//     `PhysicalFixture` are cut out of their source files between their
//     BEGIN/END markers, compiled together with `swiftc` and run on the same
//     argument vectors and tags, and required to agree;
//   * the launchers' own `fixture_tag_is_valid`, `fixture_name_for_tag` and
//     `phase_fixture_tag` functions are cut out of the two scripts and run
//     under bash on the same tags;
//   * staging is replayed into an owned fake Documents that already holds the
//     untagged brief, which must survive byte for byte. That replay is a MODEL
//     of the product's staging and refuse-on-taken-name commit written here in
//     Node — only the resolved name comes from the executed Swift parser. It is
//     not app file IO and proves nothing about a real device.
//
// The default run reads only the current working-tree sources, so it passes
// after a commit, in a shallow checkout and after unrelated later commits.
// An OPTIONAL historical comparison runs only when
// RELAYIUM_FIXTURE_BASELINE_REF names a pre-fix revision explicitly (for
// example the commit before the fix); it replays that revision's fixed name
// through the same model and requires the old collision. Without it, it is
// reported as not run.
//
// Needs `swiftc` and bash. Touches no device and no network. Scratch, module
// cache and temporary files live under $RELAYIUM_FIXTURE_TEST_SCRATCH when set,
// otherwise under a fresh directory in $TMPDIR, which is removed afterwards.

import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const paths = {
  mode: "apps/ios/Relayium/UITestMode.swift",
  suite: "apps/ios/RelayiumUITests/DevicePairAcceptance.swift",
  inboxSuite: "apps/ios/RelayiumUITests/DeviceInboxAcceptanceUITests.swift",
  pair: "scripts/ios-device-pair-acceptance.sh",
  inbox: "scripts/ios-device-inbox-acceptance.sh",
};
const UNTAGGED = "Relayium product brief.txt";
const ARGUMENT = "--relayium-ui-testing-fixture-tag";

const failures = [];
let cases = 0;
function expect(what, want, got) {
  cases += 1;
  const ok = JSON.stringify(want) === JSON.stringify(got);
  if (!ok) failures.push(`${what}: expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`);
  process.stdout.write(`${ok ? "ok  " : "FAIL"} ${what}\n`);
}

const read = (rel) => readFileSync(join(repoRoot, rel), "utf8");
const baselineRef = process.env.RELAYIUM_FIXTURE_BASELINE_REF ?? "";
const readBaseline = (rel) => execFileSync("git", ["-C", repoRoot, "show", `${baselineRef}:${rel}`],
  { encoding: "utf8", maxBuffer: 16 << 20 });

function block(source, name) {
  const begin = source.indexOf(`// BEGIN ${name}`);
  const end = source.indexOf(`// END ${name}`);
  if (begin < 0 || end < begin) return null;
  return source.slice(begin, end);
}

function shellFunctions(source, names) {
  return names.map((name) => {
    const match = source.match(new RegExp(`^${name}\\(\\) \\{\\n[\\s\\S]*?^\\}\\n`, "m"));
    if (!match) throw new Error(`no ${name}() in the launcher`);
    return match[0];
  }).join("\n");
}

const ownScratch = process.env.RELAYIUM_FIXTURE_TEST_SCRATCH;
const scratch = ownScratch
  ? (mkdirSync(ownScratch, { recursive: true }), mkdtempSync(join(ownScratch, "run-")))
  : mkdtempSync(join(tmpdir(), "relayium-fixture-"));
const childEnv = {
  ...process.env,
  TMPDIR: join(scratch, "tmp") + sep,
  CLANG_MODULE_CACHE_PATH: join(scratch, "clang-cache"),
};
mkdirSync(join(scratch, "tmp"), { recursive: true });

// The inputs every implementation is run on.
const goodTags = ["abcd1234", "0123beef", "abcd1234-nearby-ab", "abcd1234-files-ba",
  "abcd1234-text-ab", "abcd1234-x", "abcd1234-0123456789ab"];
const badTags = ["", "ABCD1234", "abcd123", "abcd12345", "abcg1234", "../../x",
  "abcd1234/x", "abcd1234-", "-abcd1234", "abcd1234--x", "abcd1234-a-b-c",
  "abcd1234-NEAR", "abcd1234 x", "abcd1234-0123456789abc", "abcd1234.txt",
  "abcd1234\nx", "abcd1234\u0000", "abcd1234-é", "ａbcd1234"];
const vectors = [
  { what: "no tag argument keeps the untagged name", args: ["/app"], want: UNTAGGED },
  { what: "unrelated arguments keep the untagged name",
    args: ["/app", "--relayium-ui-testing-link-fixture", "-AppleLanguages", "(en)"], want: UNTAGGED },
  { what: "a valid run tag names the run's brief",
    args: ["/app", ARGUMENT, "abcd1234"], want: "Relayium product brief abcd1234.txt" },
  { what: "a valid phase tag names the phase's brief",
    args: ["/app", "--relayium-ui-testing-link-fixture", ARGUMENT, "abcd1234-nearby-ab"],
    want: "Relayium product brief abcd1234-nearby-ab.txt" },
  { what: "a second run names a different brief",
    args: ["/app", ARGUMENT, "0123beef"], want: "Relayium product brief 0123beef.txt" },
  { what: "a bare flag with no value stages nothing", args: ["/app", ARGUMENT], want: null },
  { what: "a repeated flag stages nothing, even with equal values",
    args: ["/app", ARGUMENT, "abcd1234", ARGUMENT, "abcd1234"], want: null },
  { what: "the = form stages nothing", args: ["/app", `${ARGUMENT}=abcd1234`], want: null },
  { what: "a lookalike flag stages nothing", args: ["/app", `${ARGUMENT}s`, "abcd1234"], want: null },
  { what: "a flag swallowing the next flag stages nothing",
    args: ["/app", ARGUMENT, "--relayium-ui-testing-link-fixture"], want: null },
  ...badTags.map((tag) => ({ what: `malformed tag ${JSON.stringify(tag)} stages nothing`,
    args: ["/app", ARGUMENT, tag], want: null })),
];

function swiftDriver(appBlock, suiteBlock) {
  return `
enum AppSide {
${appBlock}
}
${suiteBlock}
func decode(_ hex: String) -> String {
    var bytes: [UInt8] = []
    var chars = Array(hex.utf8)
    while chars.count >= 2 {
        let pair = String(decoding: chars[0..<2], as: UTF8.self)
        bytes.append(UInt8(pair, radix: 16)!)
        chars.removeFirst(2)
    }
    return String(decoding: bytes, as: UTF8.self)
}
func encode(_ value: String) -> String {
    value.utf8.map { String($0, radix: 16).count == 1 ? "0" + String($0, radix: 16) : String($0, radix: 16) }.joined()
}
while let line = readLine(strippingNewline: true) {
    let fields = line.split(separator: " ", omittingEmptySubsequences: false).map { decode(String($0)) }
    switch fields[0] {
    case "resolve":
        let name = AppSide.FixtureName.resolve(Array(fields.dropFirst()), untagged: "${UNTAGGED}")
        print(name.map { "N" + encode($0) } ?? "nil")
    case "valid":
        print("\\(AppSide.FixtureName.isValidTag(fields[1])) \\(PhysicalFixture.isValidTag(fields[1]))")
    case "suite-name":
        print(encode(PhysicalFixture.name(tag: fields[1])) + " " + encode(PhysicalFixture.stem(tag: fields[1])))
    case "constants":
        print("\\(AppSide.FixtureName.argument == PhysicalFixture.argument) \\(AppSide.FixtureName.stem == PhysicalFixture.stem) " + encode(AppSide.FixtureName.argument))
    default:
        print("unknown")
    }
}
`;
}

const hex = (s) => Buffer.from(s, "utf8").toString("hex");
const unhex = (s) => Buffer.from(s, "hex").toString("utf8");

function runDriver(binary, lines) {
  const input = lines.map((fields) => fields.map(hex).join(" ")).join("\n") + "\n";
  const out = execFileSync(binary, [], { input, encoding: "utf8", env: childEnv });
  return out.trimEnd().split("\n");
}

try {
  const mode = read(paths.mode);
  const suite = read(paths.suite);

  // ── where the parser lives ───────────────────────────────────────────────
  const arms = mode.split("\n    #else\n");
  expect("UITestMode still has exactly one Debug/Release split", 2, arms.length);
  const appBlock = block(mode, "physical-fixture-name");
  const suiteBlock = block(suite, "physical-fixture-suite");
  expect("the product's fixture-name block exists", true, appBlock !== null);
  expect("the suites' fixture-name block exists", true, suiteBlock !== null);
  expect("the product's block is inside the Debug arm", true,
    arms[0].includes("// BEGIN physical-fixture-name") && arms[0].includes("// END physical-fixture-name"));
  expect("the Release arm names neither the argument nor the parser", [false, false, false],
    [arms[1].includes(ARGUMENT), arms[1].includes("FixtureName"), arms[1].includes("stagedPendingFixtureName")]);
  expect("the staged URL is built from the resolved name only", true,
    /guard stagesPendingFixture, let name = stagedPendingFixtureName,/.test(mode)
    && /appendingPathComponent\(name, isDirectory: false\)/.test(mode)
    && !/appendingPathComponent\(pendingFixtureName\)/.test(mode));
  expect("the untagged default is still the offline suites' name", true,
    mode.includes(`static let pendingFixtureName = "${UNTAGGED}"`)
    && /FixtureName\.resolve\(\s*ProcessInfo\.processInfo\.arguments, untagged: pendingFixtureName\)/.test(mode));
  expect("the fixture is still 1,536 bytes of 0x52", true,
    mode.includes("pendingFixtureByteCount = 1_536")
    && mode.includes("Data(repeating: 0x52, count: pendingFixtureByteCount)"));

  // ── compile the exact source and execute it ──────────────────────────────
  const driverSource = join(scratch, "driver.swift");
  const binary = join(scratch, "driver");
  writeFileSync(driverSource, swiftDriver(appBlock ?? "", suiteBlock ?? ""));
  const compiled = spawnSync("swiftc", ["-module-cache-path", join(scratch, "module-cache"),
    driverSource, "-o", binary], { encoding: "utf8", env: childEnv });
  expect("the cut-out product and suite source compiles", 0, compiled.status);
  if (compiled.status !== 0) {
    process.stdout.write(compiled.stderr);
    throw new Error("swiftc failed");
  }

  const resolved = runDriver(binary, vectors.map((v) => ["resolve", ...v.args]))
    .map((line) => (line === "nil" ? null : unhex(line.slice(1))));
  vectors.forEach((v, i) => expect(`product: ${v.what}`, v.want, resolved[i]));

  const allTags = [...goodTags, ...badTags];
  const validity = runDriver(binary, allTags.map((t) => ["valid", t]));
  allTags.forEach((tag, i) => {
    const want = goodTags.includes(tag);
    expect(`product and suites agree ${JSON.stringify(tag)} is ${want ? "valid" : "refused"}`,
      `${want} ${want}`, validity[i]);
  });
  const suiteNames = runDriver(binary, goodTags.map((t) => ["suite-name", t]));
  const productNames = runDriver(binary, goodTags.map((t) => ["resolve", "/app", ARGUMENT, t]))
    .map((line) => unhex(line.slice(1)));
  goodTags.forEach((tag, i) => {
    const [name, stem] = suiteNames[i].split(" ").map(unhex);
    expect(`the suites assert the name the product stages for ${tag}`, productNames[i], name);
    expect(`the suites' browser stem prefixes only that name for ${tag}`,
      [true, false], [name.startsWith(stem), UNTAGGED.startsWith(stem)]);
  });
  expect("product and suites share the argument and stem", `true true ${hex(ARGUMENT)}`,
    runDriver(binary, [["constants"]])[0]);

  // ── the launchers' own functions, executed ───────────────────────────────
  for (const key of ["pair", "inbox"]) {
    const functions = shellFunctions(read(paths[key]), ["fixture_tag_is_valid", "fixture_name_for_tag"]);
    for (const tag of allTags) {
      if (tag.includes("\u0000")) continue; // argv cannot carry NUL; the Swift parser covers it
      const run = spawnSync("bash", ["-c", `${functions}\nfixture_name_for_tag "$1"`, "control", tag],
        { encoding: "utf8", env: childEnv });
      const want = goodTags.includes(tag) ? `Relayium product brief ${tag}.txt` : null;
      expect(`${key} launcher names ${JSON.stringify(tag)} exactly as the product would`,
        want, run.status === 0 ? run.stdout : null);
    }
  }
  const pairSource = read(paths.pair);
  const phaseFunctions = shellFunctions(pairSource,
    ["fixture_tag_is_valid", "fixture_name_for_tag", "phase_fixture_tag"]);
  const phases = ["nearby a-to-b", "nearby b-to-a", "pairing-files a-to-b",
    "pairing-files b-to-a", "pairing-text a-to-b", "pairing-text b-to-a"];
  const phaseTags = (tag) => phases.map((phase) => {
    const run = spawnSync("bash", ["-c", `${phaseFunctions}\nphase_fixture_tag "$1" $2`, "control",
      tag, phase], { encoding: "utf8", env: childEnv });
    return run.status === 0 ? run.stdout : null;
  });
  const runA = phaseTags("abcd1234");
  const runB = phaseTags("0123beef");
  expect("every phase of one run gets its own tag", 6, new Set(runA).size);
  expect("no phase of one run shares a tag with another run", 0,
    runA.filter((t) => runB.includes(t)).length);
  const phaseValidity = runDriver(binary, runA.map((t) => ["valid", t ?? ""]));
  expect("every phase tag is one the product and suites accept", phases.map(() => "true true"),
    phaseValidity);
  expect("a malformed run tag composes no phase tag", [null, null],
    [phaseTags("ABCD1234")[0], phaseTags("../x")[0]]);
  expect("the pair launcher passes the phase tag and keeps Received by default", [true, true, false],
    [pairSource.includes('TEST_RUNNER_RELAYIUM_DEVICE_PAIR_FIXTURE_TAG="$fixture_tag"'),
      /^keep_received=1$/m.test(pairSource), /^keep_received=0$/m.test(pairSource)]);
  expect("the inbox launcher passes the run's tag", true,
    read(paths.inbox).includes('TEST_RUNNER_RELAYIUM_DEVICE_INBOX_FIXTURE_TAG="$fixture_tag"'));
  const inboxSuite = read(paths.inboxSuite);
  expect("the suites require the tag and pass it beside the staging argument",
    [true, true, true, true],
    [suite.includes('value("FIXTURE_TAG")') && suite.includes('fixtureTag.hasPrefix(tag + "-")'),
      suite.includes("[DevicePair.linkFixtureArgument, PhysicalFixture.argument]"),
      inboxSuite.includes('value("FIXTURE_TAG"), fixtureTag == tag'),
      inboxSuite.includes("PhysicalFixture.argument, run.fixtureTag]")]);
  expect("the pair suite refuses a run that would reset Received", true,
    /guard value\("KEEP_RECEIVED"\) == "1" else \{/.test(suite));

  // ── staging MODEL replayed into an owned Documents holding the brief ─────
  // Node writes these files; only each name comes from the executed parser.
  const ownerBytes = Buffer.from("owner-received-file\n");
  const fixtureBytes = Buffer.alloc(1536, 0x52);
  function replay(nameFor, label) {
    const documents = join(scratch, `documents-${label}`);
    const received = join(documents, "Received");
    mkdirSync(received, { recursive: true });
    writeFileSync(join(received, UNTAGGED), ownerBytes);
    writeFileSync(join(documents, UNTAGGED), ownerBytes);
    const outcomes = [];
    for (const args of [["/app", ARGUMENT, "abcd1234-nearby-ab"], ["/app", ARGUMENT, "0123beef-nearby-ab"],
      ["/app", ARGUMENT, "../Received/x"], ["/app", ARGUMENT]]) {
      const name = nameFor(args);
      if (name === null) { outcomes.push("refused"); continue; }
      const staged = resolve(documents, name);
      if (dirname(staged) !== documents) { outcomes.push("escaped"); continue; }
      // The product refuses a taken name in Received; Documents is rewritten.
      const arrival = join(received, name);
      outcomes.push(existsSync(arrival) ? "collision" : "received");
      writeFileSync(staged, fixtureBytes);
      if (!existsSync(arrival)) writeFileSync(arrival, fixtureBytes);
    }
    return { outcomes, ownerIntact: readFileSync(join(received, UNTAGGED)).equals(ownerBytes),
      entries: readdirSync(received).sort() };
  }
  const resolvedFor = new Map(vectors.map((v, i) => [JSON.stringify(v.args), resolved[i]]));
  const extra = runDriver(binary, [["resolve", "/app", ARGUMENT, "0123beef-nearby-ab"],
    ["resolve", "/app", ARGUMENT, "../Received/x"]]).map((l) => (l === "nil" ? null : unhex(l.slice(1))));
  resolvedFor.set(JSON.stringify(["/app", ARGUMENT, "0123beef-nearby-ab"]), extra[0]);
  resolvedFor.set(JSON.stringify(["/app", ARGUMENT, "../Received/x"]), extra[1]);
  resolvedFor.set(JSON.stringify(["/app", ARGUMENT, "abcd1234-nearby-ab"]),
    runDriver(binary, [["resolve", "/app", ARGUMENT, "abcd1234-nearby-ab"]]).map((l) => unhex(l.slice(1)))[0]);
  const now = replay((args) => resolvedFor.get(JSON.stringify(args)) ?? null, "new");
  expect("model: two runs receive, malformed input stages nothing",
    ["received", "received", "refused", "refused"], now.outcomes);
  expect("model: the owner's untagged brief survives byte for byte", true, now.ownerIntact);
  expect("model: Received holds the owner's file plus exactly the two runs' briefs",
    ["Relayium product brief 0123beef-nearby-ab.txt", "Relayium product brief abcd1234-nearby-ab.txt",
      UNTAGGED], now.entries);

  // ── the launchers' REAL runtime binding: run tag -> fixture name -> Received path ──
  // The helpers above can be right while the run never uses them. So the
  // contiguous assignment chain a real run executes is cut out of its actual
  // place — Pair: inside run_phase(), before its first start_role; Inbox: after
  // the top-level acceptance_begin, before its first start_role — and executed
  // under bash with the launcher's own helper functions, a controlled run tag
  // and a `fail` that exits 97. Nothing else of either launcher runs.
  const runtimeSpecs = {
    pair: {
      first: '  fixture_tag="$(phase_fixture_tag "$run_tag" "$flow_name" "$direction")" \\\n',
      last: '  fixture_container_path="Documents/Received/$fixture_name"\n',
      helpers: ["fixture_tag_is_valid", "fixture_name_for_tag", "phase_fixture_tag"],
      region(source) {
        const start = source.search(/^run_phase\(\) \{$/m);
        if (start < 0) return null;
        const end = source.indexOf("\n}\n", start);
        const body = source.slice(start, end);
        const firstStart = body.indexOf("\n  start_role ");
        return firstStart < 0 ? null : { text: body.slice(0, firstStart) };
      },
      env: (tag) => `run_tag=${tag}; flow_name=nearby; direction=a-to-b`,
      tagFor: (tag) => `${tag}-nearby-ab`,
    },
    inbox: {
      first: 'fixture_tag="$run_tag"\n',
      last: 'fixture_container_path="Documents/Received/$fixture_name"\n',
      helpers: ["fixture_tag_is_valid", "fixture_name_for_tag"],
      region(source) {
        const start = source.search(/^acceptance_begin$/m);
        if (start < 0) return null;
        const firstStart = source.indexOf("\n  start_role ", start);
        return firstStart < 0 ? null : { text: source.slice(start, firstStart) };
      },
      env: (tag) => `run_tag=${tag}`,
      tagFor: (tag) => tag,
    },
  };
  function runtimeBinding(kind, source) {
    const spec = runtimeSpecs[kind];
    const problems = [];
    const region = spec.region(source);
    if (!region) return { problems: ["no runtime region"] };
    const from = region.text.indexOf(spec.first);
    const to = from < 0 ? -1 : region.text.indexOf(spec.last, from);
    if (from < 0 || to < 0) return { problems: ["no contiguous tag->name->path chain in the runtime region"] };
    const chain = region.text.slice(from, to + spec.last.length);
    // Nothing after the chain in the region may rebind what it produced.
    const after = region.text.slice(to + spec.last.length);
    if (/^\s*(fixture_tag|fixture_name|fixture_container_path)=/m.test(after)) problems.push("rebound after the chain");
    let functions;
    try { functions = shellFunctions(source, spec.helpers); } catch (e) { return { problems: [String(e.message)] }; }
    const run = (tag) => spawnSync("bash", ["-c",
      `set -u\nfail() { printf 'refused\\n'; exit 97; }\n${functions}\n${spec.env(tag)}\n${chain}\n`
      + 'printf "%s|%s|%s" "$fixture_tag" "$fixture_name" "$fixture_container_path"'],
      { encoding: "utf8", env: childEnv });
    for (const tag of ["abcd1234", "0123beef"]) {
      const got = run(tag);
      const want = [spec.tagFor(tag), `Relayium product brief ${spec.tagFor(tag)}.txt`,
        `Documents/Received/Relayium product brief ${spec.tagFor(tag)}.txt`].join("|");
      if (got.status !== 0 || got.stdout !== want) problems.push(`run tag ${tag} bound ${JSON.stringify(got.stdout)} (exit ${got.status})`);
    }
    for (const tag of ["ABCD1234", "../x", "''"]) {
      const got = run(tag);
      if (got.status !== 97 || got.stdout !== "refused\n") problems.push(`malformed run tag ${tag} not refused (exit ${got.status}, ${JSON.stringify(got.stdout)})`);
    }
    return { problems, chain };
  }
  const launcherSources = { pair: pairSource, inbox: read(paths.inbox) };
  for (const kind of ["pair", "inbox"]) {
    expect(`${kind}: the real runtime chain binds run tag -> name -> Received path and refuses malformed tags`,
      [], runtimeBinding(kind, launcherSources[kind]).problems);
    const chain = runtimeBinding(kind, launcherSources[kind]).chain ?? "";
    const mutate = (from, to) => {
      const mutatedChain = chain.replace(from, to);
      if (mutatedChain === chain) throw new Error(`${kind} mutation did not apply: ${from}`);
      return launcherSources[kind].replace(chain, mutatedChain);
    };
    const mutants = {
      "fixed old name": mutate(/fixture_name="\$\(fixture_name_for_tag "\$fixture_tag"\)"/,
        'fixture_name="Relayium product brief.txt"'),
      "missing tag": kind === "pair"
        ? mutate('phase_fixture_tag "$run_tag"', 'phase_fixture_tag ""')
        : mutate('fixture_tag="$run_tag"', 'fixture_tag=""'),
      "Received path mismatch": mutate('"Documents/Received/$fixture_name"', '"Documents/$fixture_name"'),
      "helper failure not refused": mutate(/ \\\n\s+\|\| fail "[^\n]*/g, ""),
      "chain removed": launcherSources[kind].replace(chain, ""),
    };
    for (const [what, mutant] of Object.entries(mutants)) {
      expect(`${kind} mutant (${what}) is caught`, true, runtimeBinding(kind, mutant).problems.length > 0);
    }
  }

  // ── optional historical comparison, only against an explicit pre-fix ref ──
  if (!baselineRef) {
    process.stdout.write("skip historical comparison: RELAYIUM_FIXTURE_BASELINE_REF not set\n");
  } else {
    if (!/^[0-9a-f]{7,40}$/.test(baselineRef)) throw new Error("RELAYIUM_FIXTURE_BASELINE_REF must be a commit SHA");
    const oldMode = readBaseline(paths.mode);
    const oldPair = readBaseline(paths.pair);
    expect("baseline: the ref predates the fix (no tag parser)", null,
      block(oldMode, "physical-fixture-name"));
    const oldName = oldMode.match(/static let pendingFixtureName = "([^"]+)"/)?.[1];
    const before = replay(() => oldName, "old");
    expect("baseline (model): a tagged run staged the fixed name and collided on the owner's file",
      ["collision", "collision", "collision", "collision"], before.outcomes);
    expect("baseline: the pair launcher reset Received unless told not to", [true, false],
      [/^keep_received=0$/m.test(oldPair), oldPair.includes("FIXTURE_TAG")]);
  }
} catch (error) {
  failures.push(String(error?.stack ?? error));
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

if (failures.length) {
  process.stdout.write(`\n${failures.length} of ${cases} cases FAILED\n${failures.join("\n")}\n`);
  process.exit(1);
}
process.stdout.write(`\nphysical fixture isolation: ${cases} cases OK\n`);
