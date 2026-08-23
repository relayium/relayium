#!/usr/bin/env node
// scripts/test/ops-deploy-contract-test.mjs — the declarative half of the
// product↔ops deployment interface contract.
//
// ## What this file is for
//
// `relayium-ops`' auto-deploy path already assumes a set of facts about THIS
// repository: that only `web/` changes need a Web build, that only `server/`,
// `go.mod` and `go.sum` need a server build, that `npm run build -- --outDir
// <stage> --emptyOutDir` runs from `web/`, that the binary it swaps is
// `server/relayium-server`, and that a restart is a success when
// `127.0.0.1:8080/readyz` answers `ready`. None of that was ever written down
// on this side. It was a set of string literals in a shell script in another
// repository, and every one of them fails SILENTLY: a product change that
// invalidates one does not break a build, it makes a deploy quietly stop
// rebuilding something, or roll a healthy release back.
//
// `contracts/ops-deploy-v1.json` states them, once, declaratively. This file
// proves the document is internally closed and still true of the repository on
// disk. The RUNTIME half — that the real `/healthz` and `/readyz` handlers
// answer exactly what the document says, over a real connection, in every
// readiness failure branch — is `server/ops_deploy_contract_test.go`, because
// only a Go test can drive a Go handler. Both are named in the document's own
// `consumers` list, and the rules below hold that list to what actually runs.
//
// The split is a cost decision, not a taste one. This file needs no toolchain
// at all: no Go, no npm install, no browser. So it runs in `repo-hygiene.yml`,
// which carries NO path filter — which means a `web/` or `server/` change that
// invalidates a declared path, artifact or working directory is caught on the
// commit that makes it, not on the next contract edit. The Go half needs a Go
// toolchain, so it runs in `go.yml`'s `go test ./...` for ordinary source
// changes and in the dedicated `ops-deploy-contract.yml` lane for a
// contract-only edit.
//
// ## The document is not executable
//
// Nothing here — and nothing anywhere in this repository — runs a command
// string out of the contract. `program` and `argv` are DATA that a consumer
// compares its own hardcoded invocation against. This file checks their
// structure and the relationships between them and the artifacts they name; it
// never spawns them, and it never performs a build.
//
// ## Why the checks are relationships rather than literals
//
// A rule of the form `assert(contract.buildUnits[1].workingDirectory ===
// "web")` restates the document in a second place and then proves the two
// copies agree. Every rule below is instead anchored in something that is NOT
// the contract: `git ls-files`, the file system, `web/package.json`'s own
// scripts map, and a re-implementation of the ops script's prefix-matching
// semantics. Changing a product path, adding a repository-root entry, removing
// a declared input, renaming an artifact or moving a build's working directory
// therefore fails HERE, even when the contract itself was edited to match.

import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

const CONTRACT_FILE = "contracts/ops-deploy-v1.json";
const CONTRACT_NAME = "relayium.ops.deploy";
const CONTRACT_VERSION = 1;
/** The two readers that actually run in THIS repository. Named so a rule can
 *  require the document to declare each of them, which is the direction a
 *  consumer roll decays in: a reader keeps running and stops being listed. */
const GO_CONSUMER = "server/ops_deploy_contract_test.go";
const SELF_CONSUMER = "scripts/test/ops-deploy-contract-test.mjs";
/** This repository's id in `consumers[].repository`. An entry in any other
 *  repository is recorded here and verified there. */
const LOCAL_REPOSITORY = "relayium";

const failures = [];
function check(ok, message) {
  if (ok) return;
  failures.push(message);
}

const deepEqual = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** Closed key set AND key order in one place. Both matter, and for the same
 *  reason: a key set that is merely a superset lets a fact be added with no
 *  consumer, and an order that drifts makes every future review of this
 *  document a diff nobody can read. */
const keysAre = (object, want) => deepEqual(Object.keys(object ?? {}), want);
const keysMessage = (at, object, want, noun = "keys") =>
  `${at} declares ${noun} ${JSON.stringify(Object.keys(object ?? {}))}; want exactly `
  + `${JSON.stringify(want)}, in that order.`;
const sorted = (list) => [...list].sort();
const isSortedUnique = (list) =>
  list.every((value, i) => i === 0 || String(list[i - 1]) < String(value));

// ── the shape, stated once ──────────────────────────────────────────────────
//
// Key ORDER, not merely key membership. A contract that independent readers
// diff against is only reviewable while its serialisation is deterministic, and
// "the fields are all there somewhere" is not a property a reviewer can see.

const TOP_LEVEL_KEYS = [
  "contract", "contractVersion", "documentation", "consumers", "vocabularies",
  "buildUnits", "artifacts", "repositoryRootEntries", "listener",
  "healthEndpoints", "probe",
];

const VOCABULARY_KEYS = [
  "artifactKinds", "bodyTerminators", "consumerRepositories", "consumerStatuses",
  "inputClasses", "methodPolicies", "pathKinds", "presenceStates", "programs",
  "rootEffects",
];

const CONSUMER_KEYS = ["id", "repository", "status", "reader"];

const BUILD_UNIT_KEYS = [
  "unit", "workingDirectory", "manifest", "inputs", "command", "produces",
  "rebuildWhenMissing",
];
const INPUT_KEYS = ["path", "class", "presence"];
const COMMAND_KEYS = ["program", "argv", "outputFlag"];
const ARTIFACT_KEYS = ["id", "path", "kind", "pathKind", "producedBy", "gitTracked"];
const ROOT_ENTRY_KEYS = ["entry", "effect"];
const LISTENER_KEYS = ["defaultAddress", "defaultPort", "addressFlag", "addressEnvironment"];
const HEALTH_KEYS = [
  "id", "path", "methodPolicy", "successStatus", "successBody",
  "successBodyTerminator", "failureStatus", "failureModes",
  "databaseTimeoutMilliseconds",
];
const FAILURE_MODE_KEYS = ["reason", "body", "bodyTerminator"];
const PROBE_KEYS = ["methods", "bodylessMethods", "nonMatchingPaths"];

/** `{{artifactId}}`, whole-element only. A partially interpolated argv element
 *  would be a command a consumer has to build by string surgery. */
const PLACEHOLDER = /^\{\{([a-z][A-Za-z0-9]*)\}\}$/;

// ── the world every rule reads ──────────────────────────────────────────────

/** Every path Git tracks, repository-relative, NUL-separated so a newline in a
 *  filename cannot forge an entry. */
function trackedPaths() {
  const result = spawnSync("git", ["-C", repoRoot, "ls-files", "-z"], {
    encoding: "utf8", maxBuffer: 64 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(`git ls-files failed: ${result.stderr || result.error?.message || result.status}`);
  }
  return result.stdout.split("\0").filter((path) => path !== "");
}

function loadWorld() {
  const raw = readFileSync(resolve(repoRoot, CONTRACT_FILE), "utf8");
  const tracked = trackedPaths();
  return {
    contract: JSON.parse(raw),
    tracked,
    trackedSet: new Set(tracked),
    // The repository-root entries Git actually has: the first segment of every
    // tracked path. Derived, so a new top-level tree appears here the moment it
    // is committed and has to be classified before this policy passes again.
    rootEntries: new Set(tracked.map((path) => path.split("/")[0])),
    // Paths that exist on disk but are not tracked — the only way an `absent`
    // declaration can be wrong without a commit.
    untrackedExists: new Set(),
    manifests: new Map(),
    sources: new Map(),
  };
}

/** Does the repository have `path`, tracked or merely present? */
function anyPresence(world, path) {
  if (world.trackedSet.has(path)) return true;
  if (world.untrackedExists.has(path)) return true;
  return existsSync(resolve(repoRoot, path));
}

/** A file's text, or null when it is not there. Cached and carried in the
 *  world, so a mutation can replace a source the way it replaces a tracked
 *  path — which is how "a reader stopped opening the document" is provable
 *  without editing a real file. */
function source(world, path) {
  if (world.sources.has(path)) return world.sources.get(path);
  let text = null;
  try {
    text = readFileSync(resolve(repoRoot, path), "utf8");
  } catch {
    text = null;
  }
  world.sources.set(path, text);
  return text;
}

/** A manifest's parsed JSON, or null. Cached so a mutation can replace it. */
function manifest(world, path) {
  if (world.manifests.has(path)) return world.manifests.get(path);
  let parsed = null;
  try {
    parsed = JSON.parse(readFileSync(resolve(repoRoot, path), "utf8"));
  } catch {
    parsed = null;
  }
  world.manifests.set(path, parsed);
  return parsed;
}

// ── the ops selective-build model, re-implemented ───────────────────────────
//
// `relayium-ops`' `_matches` tests each changed path against a list of PREFIXES
// — `case "$line" in "$p"*)` — and the whole selective-build decision is that
// one rule. Re-implementing it here is what turns "the contract lists web/" into
// "a change to this actual tracked file rebuilds the Web bundle", which is a
// claim about the repository and not about the document.

/** The declared inputs, as prefixes. A `file` class is its own exact path; a
 *  `directoryPrefix` is a prefix by construction. Both are prefix-matched,
 *  because that is what the deploy script does with either. */
const unitPrefixes = (unit) => unit.inputs.map((input) => input.path);

const unitTriggeredBy = (unit, changedPath) =>
  unitPrefixes(unit).some((prefix) => changedPath.startsWith(prefix));

/** The set of build units a single changed path starts, sorted. */
const unitsFor = (contract, changedPath) =>
  sorted(contract.buildUnits.filter((unit) => unitTriggeredBy(unit, changedPath)).map((u) => u.unit));

// ── 1. the document is closed, ordered and internally consistent ────────────

function schemaFailures(world) {
  const out = [];
  const need = (ok, message) => { if (!ok) out.push(message); };
  const contract = world.contract;

  need(
    keysAre(contract, TOP_LEVEL_KEYS),
    keysMessage(CONTRACT_FILE, contract, TOP_LEVEL_KEYS, "top-level keys"),
  );
  need(
    contract.contract === CONTRACT_NAME && contract.contractVersion === CONTRACT_VERSION,
    `${CONTRACT_FILE} identifies itself as ${JSON.stringify(contract.contract)} v`
    + `${JSON.stringify(contract.contractVersion)}; want ${CONTRACT_NAME} v${CONTRACT_VERSION}. `
    + `Both consumers select this document by that pair.`,
  );
  need(
    typeof contract.documentation === "string" && anyPresence(world, contract.documentation),
    `${CONTRACT_FILE} points at documentation ${JSON.stringify(contract.documentation)}, which does `
    + `not exist. A contract that cannot be explained is one the next author re-derives from a shell `
    + `script in another repository — which is the situation it was written to end.`,
  );

  // Vocabularies. Closed BOTH ways: a value outside its vocabulary fails, and a
  // vocabulary term nothing uses fails too. Dead vocabulary is how a closed
  // document quietly becomes an open one.
  const vocab = contract.vocabularies ?? {};
  need(keysAre(vocab, VOCABULARY_KEYS), keysMessage(`${CONTRACT_FILE}.vocabularies`, vocab, VOCABULARY_KEYS));
  for (const [name, terms] of Object.entries(vocab)) {
    need(
      Array.isArray(terms) && terms.length > 0 && isSortedUnique(terms)
      && terms.every((term) => typeof term === "string"),
      `${CONTRACT_FILE}.vocabularies.${name} is ${JSON.stringify(terms)}; want a non-empty, sorted, `
      + `duplicate-free list of strings.`,
    );
  }
  const used = {
    artifactKinds: new Set(), bodyTerminators: new Set(), consumerRepositories: new Set(),
    consumerStatuses: new Set(), inputClasses: new Set(), methodPolicies: new Set(),
    pathKinds: new Set(), presenceStates: new Set(), programs: new Set(), rootEffects: new Set(),
  };
  const inVocab = (name, value) => Array.isArray(vocab[name]) && vocab[name].includes(value);

  // Consumers. A STATUS list, not a membership list.
  //
  // The relayium-ops half that reads this document and enforces it against the
  // deploy script does not exist yet. A flat `["go", "ops"]` had no way to say
  // so, so a planned reader was published as a current one — while the reader
  // that does run on every commit was not listed at all. Each entry now carries
  // the repository it lives in and whether it is active or pending. Phase B
  // flips `ops` to active and fills in its reader without touching this schema.
  const consumers = Array.isArray(contract.consumers) ? contract.consumers : [];
  const consumerIDs = consumers.map((consumer) => consumer?.id);
  need(
    Array.isArray(contract.consumers) && consumers.length > 0 && isSortedUnique(consumerIDs),
    `${CONTRACT_FILE} declares consumers ${JSON.stringify(consumerIDs)}; want a non-empty, sorted, `
    + `duplicate-free list of ids. Two entries for one id are two statuses for one reader, and the `
    + `second silently wins.`,
  );
  for (const consumer of consumers) {
    const at = `${CONTRACT_FILE}.consumers[${JSON.stringify(consumer?.id)}]`;
    need(keysAre(consumer, CONSUMER_KEYS), keysMessage(at, consumer, CONSUMER_KEYS));
    need(
      inVocab("consumerStatuses", consumer?.status),
      `${at}.status is ${JSON.stringify(consumer?.status)}, which is not in `
      + `vocabularies.consumerStatuses ${JSON.stringify(vocab.consumerStatuses)}. A status outside `
      + `the vocabulary is free text, and free text is how "planned" and "enforcing" stop being `
      + `different states.`,
    );
    need(
      inVocab("consumerRepositories", consumer?.repository),
      `${at}.repository is ${JSON.stringify(consumer?.repository)}, which is not in `
      + `vocabularies.consumerRepositories ${JSON.stringify(vocab.consumerRepositories)}. That `
      + `field is what selects whether this repository can open the reader at all.`,
    );
    used.consumerStatuses.add(consumer?.status);
    used.consumerRepositories.add(consumer?.repository);
    need(
      consumer?.reader === null
      || (typeof consumer?.reader === "string" && consumer.reader !== ""
        && !consumer.reader.startsWith("/")),
      `${at}.reader is ${JSON.stringify(consumer?.reader)}; want a repository-relative path, or `
      + `null when there is nothing to point at yet.`,
    );
    need(
      consumer?.status !== "pending" || consumer?.reader === null,
      `${at} is pending but names reader ${JSON.stringify(consumer?.reader)}. A consumer with a `
      + `reader on record is either enforcing this contract or broken; neither one is pending.`,
    );
    need(
      consumer?.status !== "active" || (consumer?.reader ?? null) !== null,
      `${at} is active but names no reader. \`active\` is the claim that something reads this `
      + `document today, and an entry with nothing to point at is exactly how planned enforcement `
      + `gets published as current.`,
    );
  }

  // Build units.
  const unitNames = (contract.buildUnits ?? []).map((unit) => unit.unit);
  need(
    Array.isArray(contract.buildUnits) && contract.buildUnits.length > 0 && isSortedUnique(unitNames),
    `${CONTRACT_FILE}.buildUnits names ${JSON.stringify(unitNames)}; want a non-empty, sorted, `
    + `duplicate-free list. Two units with one name is a rebuild rule that silently shadows another.`,
  );
  const artifactIDs = new Set((contract.artifacts ?? []).map((artifact) => artifact.id));

  for (const unit of contract.buildUnits ?? []) {
    const at = `${CONTRACT_FILE}.buildUnits[${JSON.stringify(unit.unit)}]`;
    need(keysAre(unit, BUILD_UNIT_KEYS), keysMessage(at, unit, BUILD_UNIT_KEYS));
    const inputPaths = (unit.inputs ?? []).map((input) => input.path);
    need(
      Array.isArray(unit.inputs) && unit.inputs.length > 0 && isSortedUnique(inputPaths),
      `${at}.inputs names ${JSON.stringify(inputPaths)}; want a non-empty, sorted, duplicate-free `
      + `list. A duplicated input is a selective-build rule stated twice and maintained once.`,
    );
    for (const input of unit.inputs ?? []) {
      need(
        keysAre(input, INPUT_KEYS),
        keysMessage(`${at}.inputs[${JSON.stringify(input.path)}]`, input, INPUT_KEYS),
      );
      need(
        inVocab("inputClasses", input.class),
        `${at}.inputs[${JSON.stringify(input.path)}] has path class ${JSON.stringify(input.class)}, `
        + `which is not in vocabularies.inputClasses ${JSON.stringify(vocab.inputClasses)}. An `
        + `unknown class is an input no consumer knows how to match.`,
      );
      need(
        inVocab("presenceStates", input.presence),
        `${at}.inputs[${JSON.stringify(input.path)}] has presence ${JSON.stringify(input.presence)}, `
        + `which is not in vocabularies.presenceStates.`,
      );
      used.inputClasses.add(input.class);
      used.presenceStates.add(input.presence);
      need(
        input.class !== "directoryPrefix" || String(input.path).endsWith("/"),
        `${at}.inputs[${JSON.stringify(input.path)}] is a directoryPrefix that does not end in "/". `
        + `The deploy script matches by raw prefix, so ${JSON.stringify(input.path)} would also `
        + `select a sibling like ${JSON.stringify(`${input.path}-old/x`)}.`,
      );
      need(
        input.class !== "file" || !String(input.path).endsWith("/"),
        `${at}.inputs[${JSON.stringify(input.path)}] is classed as a file but ends in "/".`,
      );
    }

    // Command structure. Never executed — see the header. What is checked is
    // that the argv is well formed and that every path it names is an artifact
    // this contract declares.
    const command = unit.command ?? {};
    need(keysAre(command, COMMAND_KEYS), keysMessage(`${at}.command`, command, COMMAND_KEYS));
    need(
      inVocab("programs", command.program),
      `${at}.command.program is ${JSON.stringify(command.program)}, which is not in `
      + `vocabularies.programs ${JSON.stringify(vocab.programs)}.`,
    );
    used.programs.add(command.program);
    need(
      Array.isArray(command.argv) && command.argv.length > 0
      && command.argv.every((arg) => typeof arg === "string" && arg !== ""),
      `${at}.command.argv is ${JSON.stringify(command.argv)}; want a non-empty list of non-empty `
      + `strings.`,
    );
    const placeholders = [];
    for (const arg of command.argv ?? []) {
      if (!String(arg).includes("{{") && !String(arg).includes("}}")) continue;
      const match = PLACEHOLDER.exec(String(arg));
      need(
        match !== null,
        `${at}.command.argv contains ${JSON.stringify(arg)}, which is not a whole-element `
        + `placeholder. The syntax is exactly {{artifactId}} as one argv element: a partially `
        + `interpolated argument is a command a consumer has to assemble by string surgery, and `
        + `this document is not a command source.`,
      );
      if (match) placeholders.push(match[1]);
    }
    for (const id of placeholders) {
      need(
        artifactIDs.has(id),
        `${at}.command.argv names placeholder {{${id}}}, which is not a declared artifact id `
        + `(${JSON.stringify([...artifactIDs].sort())}). The command would then write somewhere the `
        + `contract does not describe.`,
      );
      need(
        (unit.produces ?? []).includes(id),
        `${at}.command.argv writes to {{${id}}}, but ${at}.produces is `
        + `${JSON.stringify(unit.produces)}. A command whose output is not declared as produced is `
        + `an artifact no consumer knows to publish, prune or roll back.`,
      );
    }
    need(
      isSortedUnique(unit.produces ?? []) || (unit.produces ?? []).length <= 1,
      `${at}.produces is ${JSON.stringify(unit.produces)}; want a sorted, duplicate-free list.`,
    );
    for (const id of unit.produces ?? []) {
      need(
        artifactIDs.has(id),
        `${at}.produces names ${JSON.stringify(id)}, which is not a declared artifact.`,
      );
    }
    const outputFlag = command.outputFlag;
    if (placeholders.length === 0) {
      need(
        outputFlag === null,
        `${at}.command declares outputFlag ${JSON.stringify(outputFlag)} but its argv writes to no `
        + `placeholder. The two are one fact stated twice.`,
      );
    } else {
      need(
        placeholders.length === 1,
        `${at}.command.argv writes to ${placeholders.length} placeholders `
        + `(${JSON.stringify(placeholders)}); this contract models one output path per command.`,
      );
      const argv = command.argv ?? [];
      const flagAt = argv.indexOf(outputFlag);
      need(
        typeof outputFlag === "string" && flagAt !== -1
        && argv.indexOf(outputFlag, flagAt + 1) === -1,
        `${at}.command declares outputFlag ${JSON.stringify(outputFlag)}, which appears `
        + `${argv.filter((a) => a === outputFlag).length} times in ${JSON.stringify(argv)}; want `
        + `exactly once.`,
      );
      need(
        flagAt !== -1 && PLACEHOLDER.test(String(argv[flagAt + 1] ?? "")),
        `${at}.command's output flag ${JSON.stringify(outputFlag)} is not immediately followed by `
        + `its placeholder in ${JSON.stringify(argv)}. That adjacency is the whole reason the flag `
        + `is declared: it is what makes "the build writes to this artifact" checkable instead of a `
        + `literal repeated in two places.`,
      );
    }
    need(
      artifactIDs.has(unit.rebuildWhenMissing),
      `${at}.rebuildWhenMissing is ${JSON.stringify(unit.rebuildWhenMissing)}, which is not a `
      + `declared artifact. That field is the deploy path's recovery rule — rebuild when the output `
      + `is gone even though no input changed — so it must name something the contract describes.`,
    );
  }

  // Artifacts, and the back-reference to their producing unit.
  const ids = (contract.artifacts ?? []).map((artifact) => artifact.id);
  need(
    Array.isArray(contract.artifacts) && contract.artifacts.length > 0 && isSortedUnique(ids),
    `${CONTRACT_FILE}.artifacts declares ids ${JSON.stringify(ids)}; want a non-empty, sorted, `
    + `duplicate-free list.`,
  );
  for (const artifact of contract.artifacts ?? []) {
    const at = `${CONTRACT_FILE}.artifacts[${JSON.stringify(artifact.id)}]`;
    need(keysAre(artifact, ARTIFACT_KEYS), keysMessage(at, artifact, ARTIFACT_KEYS));
    need(
      inVocab("artifactKinds", artifact.kind),
      `${at}.kind is ${JSON.stringify(artifact.kind)}, which is not in vocabularies.artifactKinds.`,
    );
    need(
      inVocab("pathKinds", artifact.pathKind),
      `${at}.pathKind is ${JSON.stringify(artifact.pathKind)}, which is not in vocabularies.pathKinds.`,
    );
    used.artifactKinds.add(artifact.kind);
    used.pathKinds.add(artifact.pathKind);
    need(
      typeof artifact.gitTracked === "boolean",
      `${at}.gitTracked is ${JSON.stringify(artifact.gitTracked)}; want a boolean.`,
    );
    const producers = (contract.buildUnits ?? [])
      .filter((unit) => (unit.produces ?? []).includes(artifact.id))
      .map((unit) => unit.unit);
    if (artifact.producedBy === null) {
      need(
        producers.length === 0,
        `${at}.producedBy is null, but ${JSON.stringify(producers)} declare it in \`produces\`. The `
        + `two directions of one relationship disagree, which is exactly the drift a cross-reference `
        + `is for.`,
      );
    } else {
      need(
        deepEqual(producers, [artifact.producedBy]),
        `${at}.producedBy is ${JSON.stringify(artifact.producedBy)}, but the units declaring it in `
        + `\`produces\` are ${JSON.stringify(producers)}.`,
      );
    }
  }

  // Repository-root entries.
  const entries = (contract.repositoryRootEntries ?? []).map((entry) => entry.entry);
  need(
    isSortedUnique(entries),
    `${CONTRACT_FILE}.repositoryRootEntries names ${JSON.stringify(entries)}; want a sorted, `
    + `duplicate-free list.`,
  );
  for (const entry of contract.repositoryRootEntries ?? []) {
    need(
      keysAre(entry, ROOT_ENTRY_KEYS),
      keysMessage(`${CONTRACT_FILE}.repositoryRootEntries[${JSON.stringify(entry.entry)}]`,
        entry, ROOT_ENTRY_KEYS),
    );
    need(
      inVocab("rootEffects", entry.effect),
      `${CONTRACT_FILE}.repositoryRootEntries[${JSON.stringify(entry.entry)}].effect is `
      + `${JSON.stringify(entry.effect)}, which is not in vocabularies.rootEffects.`,
    );
    used.rootEffects.add(entry.effect);
  }

  // Listener.
  const listener = contract.listener ?? {};
  need(keysAre(listener, LISTENER_KEYS), keysMessage(`${CONTRACT_FILE}.listener`, listener, LISTENER_KEYS));
  need(
    typeof listener.defaultAddress === "string"
    && /^(?:[^:]*):(\d+)$/.test(listener.defaultAddress),
    `${CONTRACT_FILE}.listener.defaultAddress is ${JSON.stringify(listener.defaultAddress)}; want a `
    + `host:port string.`,
  );
  const declaredPort = Number(String(listener.defaultAddress ?? "").split(":").pop());
  need(
    Number.isInteger(listener.defaultPort) && listener.defaultPort === declaredPort
    && listener.defaultPort > 0 && listener.defaultPort < 65536,
    `${CONTRACT_FILE}.listener.defaultPort is ${JSON.stringify(listener.defaultPort)} but its `
    + `defaultAddress ${JSON.stringify(listener.defaultAddress)} resolves to ${declaredPort}. The `
    + `deploy path polls the PORT; a document where the two disagree points it somewhere the server `
    + `is not.`,
  );
  need(
    typeof listener.addressFlag === "string" && listener.addressFlag !== ""
    && !listener.addressFlag.startsWith("-"),
    `${CONTRACT_FILE}.listener.addressFlag is ${JSON.stringify(listener.addressFlag)}; want the bare `
    + `flag name, without a leading dash.`,
  );
  need(
    typeof listener.addressEnvironment === "string"
    && /^[A-Z][A-Z0-9_]*$/.test(String(listener.addressEnvironment)),
    `${CONTRACT_FILE}.listener.addressEnvironment is ${JSON.stringify(listener.addressEnvironment)}; `
    + `want an UPPER_SNAKE environment variable name.`,
  );

  // Health endpoints.
  const healthIDs = (contract.healthEndpoints ?? []).map((endpoint) => endpoint.id);
  need(
    Array.isArray(contract.healthEndpoints) && isSortedUnique(healthIDs)
    && deepEqual(healthIDs, ["liveness", "readiness"]),
    `${CONTRACT_FILE}.healthEndpoints declares ${JSON.stringify(healthIDs)}; want exactly `
    + `["liveness", "readiness"]. Those two ids are what the Go consumer and the deploy path each `
    + `select by name.`,
  );
  const healthPaths = new Set();
  for (const endpoint of contract.healthEndpoints ?? []) {
    const at = `${CONTRACT_FILE}.healthEndpoints[${JSON.stringify(endpoint.id)}]`;
    need(keysAre(endpoint, HEALTH_KEYS), keysMessage(at, endpoint, HEALTH_KEYS));
    need(
      typeof endpoint.path === "string" && endpoint.path.startsWith("/")
      && !endpoint.path.endsWith("/"),
      `${at}.path is ${JSON.stringify(endpoint.path)}; want an absolute path with no trailing slash. `
      + `Go's ServeMux reads a trailing slash as a SUBTREE, which is a different endpoint from the `
      + `one the deploy path polls.`,
    );
    healthPaths.add(endpoint.path);
    need(
      inVocab("methodPolicies", endpoint.methodPolicy),
      `${at}.methodPolicy is ${JSON.stringify(endpoint.methodPolicy)}, which is not in `
      + `vocabularies.methodPolicies.`,
    );
    used.methodPolicies.add(endpoint.methodPolicy);
    need(
      endpoint.successStatus === 200,
      `${at}.successStatus is ${JSON.stringify(endpoint.successStatus)}; the deploy path treats `
      + `anything but 200 as not-yet-ready and eventually as a failed release.`,
    );
    need(
      typeof endpoint.successBody === "string" && endpoint.successBody !== ""
      && !/\s/.test(endpoint.successBody),
      `${at}.successBody is ${JSON.stringify(endpoint.successBody)}; want a non-empty token with no `
      + `whitespace. The deploy poll matches it as a WHOLE line.`,
    );
    // successBody is the NON-BODYLESS wire entity body: what a client reads for
    // every probed method outside `probe.bodylessMethods`. See that field.
    need(
      inVocab("bodyTerminators", endpoint.successBodyTerminator),
      `${at}.successBodyTerminator is ${JSON.stringify(endpoint.successBodyTerminator)}, which is `
      + `not in vocabularies.bodyTerminators.`,
    );
    used.bodyTerminators.add(endpoint.successBodyTerminator);

    const reasons = (endpoint.failureModes ?? []).map((mode) => mode.reason);
    need(
      Array.isArray(endpoint.failureModes) && isSortedUnique(reasons),
      `${at}.failureModes names ${JSON.stringify(reasons)}; want a sorted, duplicate-free list.`,
    );
    for (const mode of endpoint.failureModes ?? []) {
      need(
        keysAre(mode, FAILURE_MODE_KEYS),
        keysMessage(`${at}.failureModes[${JSON.stringify(mode.reason)}]`, mode, FAILURE_MODE_KEYS),
      );
      need(
        inVocab("bodyTerminators", mode.bodyTerminator),
        `${at}.failureModes[${JSON.stringify(mode.reason)}].bodyTerminator is `
        + `${JSON.stringify(mode.bodyTerminator)}, which is not in vocabularies.bodyTerminators.`,
      );
      used.bodyTerminators.add(mode.bodyTerminator);
    }
    // The two nullable fields are conditional, and both directions matter: a
    // status with no mode bounds nothing, and modes with no status leave the
    // consumer nothing to compare a 503 against.
    need(
      (endpoint.failureModes ?? []).length === 0
        ? endpoint.failureStatus === null
        : endpoint.failureStatus === 503,
      `${at} declares ${(endpoint.failureModes ?? []).length} failure modes and failureStatus `
      + `${JSON.stringify(endpoint.failureStatus)}. Want null with no modes, and 503 with any.`,
    );
    need(
      reasons.includes("databasePingFailed")
        ? Number.isInteger(endpoint.databaseTimeoutMilliseconds)
          && endpoint.databaseTimeoutMilliseconds > 0
        : endpoint.databaseTimeoutMilliseconds === null,
      `${at}.databaseTimeoutMilliseconds is ${JSON.stringify(endpoint.databaseTimeoutMilliseconds)}, `
      + `which does not match its failure modes ${JSON.stringify(reasons)}. An endpoint that can `
      + `fail on a database ping must bound it; one that cannot must not pretend to.`,
    );
  }

  // Probe inputs.
  const probe = contract.probe ?? {};
  need(keysAre(probe, PROBE_KEYS), keysMessage(`${CONTRACT_FILE}.probe`, probe, PROBE_KEYS));
  need(
    Array.isArray(probe.methods) && probe.methods.length > 0 && isSortedUnique(probe.methods)
    && probe.methods.every((method) => /^[A-Z]+$/.test(String(method))),
    `${CONTRACT_FILE}.probe.methods is ${JSON.stringify(probe.methods)}; want a non-empty, sorted, `
    + `duplicate-free list of upper-case HTTP methods. It is what a "${"any"}" method policy is `
    + `PROVED against — an empty list would make that policy an assertion about nothing.`,
  );
  need(
    Array.isArray(probe.methods) && probe.methods.includes("GET"),
    `${CONTRACT_FILE}.probe.methods omits GET, which is the method the deploy path's own poll uses.`,
  );
  // Which probed methods carry no entity body is not a choice this document
  // gets to make. Go's net/http suppresses the body of a HEAD response AT THE
  // SERVER — after the handler has already written it — and does that for HEAD
  // and nothing else. So the set is DERIVED from the transport rather than
  // declared, and `successBody` is what a client reads for every other probed
  // method.
  const wantBodyless = (probe.methods ?? []).filter((method) => method === "HEAD");
  const readiness = (contract.healthEndpoints ?? []).find((entry) => entry.id === "readiness");
  need(
    deepEqual(probe.bodylessMethods, wantBodyless),
    `${CONTRACT_FILE}.probe.bodylessMethods is ${JSON.stringify(probe.bodylessMethods)}; want `
    + `${JSON.stringify(wantBodyless)}, derived from probe.methods `
    + `${JSON.stringify(probe.methods)}. net/http withholds the entity body of a HEAD response and `
    + `of no other method. Dropping HEAD from this list restores the claim that a HEAD probe of `
    + `${JSON.stringify(readiness?.path)} answers ${JSON.stringify(readiness?.successBody)} when a `
    + `real client receives nothing; adding another method claims a body suppression the transport `
    + `does not perform.`,
  );
  need(
    Array.isArray(probe.nonMatchingPaths) && probe.nonMatchingPaths.length > 0
    && isSortedUnique(probe.nonMatchingPaths),
    `${CONTRACT_FILE}.probe.nonMatchingPaths is ${JSON.stringify(probe.nonMatchingPaths)}; want a `
    + `non-empty, sorted, duplicate-free list.`,
  );
  for (const path of probe.nonMatchingPaths ?? []) {
    need(
      !healthPaths.has(path),
      `${CONTRACT_FILE}.probe.nonMatchingPaths contains ${JSON.stringify(path)}, which is also a `
      + `health endpoint path. The Go consumer would then be asked to prove that a live route `
      + `answers 404.`,
    );
  }

  // No dead vocabulary.
  for (const [name, terms] of Object.entries(vocab)) {
    const unused = (Array.isArray(terms) ? terms : []).filter((term) => !used[name]?.has(term));
    need(
      unused.length === 0,
      `${CONTRACT_FILE}.vocabularies.${name} declares ${JSON.stringify(unused)}, which nothing in `
      + `this contract uses. A closed vocabulary with dead terms is an open one: the term is `
      + `available to a future edit that nobody reviewed for it.`,
    );
  }
  return out;
}

// ── 2. the document is still true of the repository on disk ─────────────────
//
// Every rule here is anchored in `git ls-files`, the file system or a manifest's
// own contents — never in a second copy of the contract.

function repositoryFailures(world) {
  const out = [];
  const need = (ok, message) => { if (!ok) out.push(message); };
  const contract = world.contract;

  // Consumers, against the tree rather than against themselves.
  //
  // A declared reader must exist AND still name the document: a reader that
  // quietly stopped opening it leaves the contract enforced by nothing while
  // its entry still says active. And the two readers that do run must each be
  // declared — the direction the flat list got wrong, by publishing a planned
  // reader and omitting a running one.
  const localReaders = new Map();
  for (const consumer of contract.consumers ?? []) {
    const at = `${CONTRACT_FILE}.consumers[${JSON.stringify(consumer?.id)}]`;
    const reader = consumer?.reader;
    if (typeof reader !== "string") continue;
    if (consumer.repository !== LOCAL_REPOSITORY) {
      // Nothing here can open it. The document may record the path the other
      // repository added; it may not point at one THIS repository resolves,
      // because then the checked file and the enforcing file are different
      // files with the same name.
      need(
        !world.trackedSet.has(reader),
        `${at} places reader ${JSON.stringify(reader)} in `
        + `${JSON.stringify(consumer.repository)}, but this repository tracks that exact path. `
        + `The file a reviewer would open is then not the file that enforces the contract.`,
      );
      continue;
    }
    localReaders.set(reader, consumer);
    need(
      world.trackedSet.has(reader),
      `${at} names reader ${JSON.stringify(reader)} in this repository, which Git does not track. `
      + `An untracked reader is not something a fresh checkout runs.`,
    );
    need(
      (source(world, reader) ?? "").includes(CONTRACT_FILE),
      `${at}'s reader ${JSON.stringify(reader)} does not name ${CONTRACT_FILE} verbatim, so it `
      + `does not open this document. Its entry would record enforcement that stopped happening, `
      + `with every check still green.`,
    );
  }
  for (const reader of [GO_CONSUMER, SELF_CONSUMER]) {
    const consumer = localReaders.get(reader);
    need(
      consumer !== undefined,
      `${reader} reads ${CONTRACT_FILE} on every run, but ${CONTRACT_FILE}.consumers declares no `
      + `active entry in ${JSON.stringify(LOCAL_REPOSITORY)} whose reader is that path (it names `
      + `${JSON.stringify([...localReaders.keys()])}). A roll that omits a reader which actually `
      + `runs describes a different contract from the one this repository enforces.`,
    );
    need(
      consumer === undefined || consumer.status === "active",
      `${CONTRACT_FILE} records ${reader} as ${JSON.stringify(consumer?.status)}. It is in this `
      + `repository and it runs, so its enforcement is not planned — it is happening.`,
    );
  }
  // The runtime half must reach the WIRE, not just the handler. net/http
  // withholds a HEAD entity body at the server, so an `httptest.ResponseRecorder`
  // reports the success body where a client reads nothing: asserted through a
  // recorder, "HEAD /readyz answers ready" passes while every deployed HEAD
  // client receives an empty body. `probe.bodylessMethods` is a claim about that
  // wire, and only a real server and client can judge it.
  need(
    (source(world, GO_CONSUMER) ?? "").includes("httptest.NewServer"),
    `${GO_CONSUMER} never constructs an httptest.NewServer, so nothing drives the production `
    + `handlers over a real connection and ${CONTRACT_FILE}.probe.bodylessMethods is asserted `
    + `against a ResponseRecorder — which reports the body net/http suppresses in transit.`,
  );

  for (const unit of contract.buildUnits ?? []) {
    const at = `${CONTRACT_FILE}.buildUnits[${JSON.stringify(unit.unit)}]`;

    // Inputs: declared presence versus what the repository actually has.
    for (const input of unit.inputs ?? []) {
      const path = String(input.path);
      const found = input.class === "directoryPrefix"
        ? world.tracked.some((tracked) => tracked.startsWith(path))
        : world.trackedSet.has(path);
      if (input.presence === "present") {
        need(
          found,
          `${at} declares ${JSON.stringify(path)} as a PRESENT build input, but Git tracks nothing `
          + `there. The deploy path's selective build would then have a rule that can never fire — `
          + `and if this is a rename, the tree it moved to has no rule at all.`,
        );
      } else {
        need(
          !found && !anyPresence(world, path),
          `${at} declares ${JSON.stringify(path)} as ABSENT, but the repository has it. It is `
          + `declared because the deploy script matches that prefix today and would rebuild for it; `
          + `now that the file exists, whether it really is a server build input is a decision, not `
          + `an assumption.`,
        );
      }
    }

    // Working directory and manifest: the toolchain must resolve the project
    // from where the command is declared to run.
    need(
      String(unit.manifest).startsWith(`${unit.workingDirectory}/`),
      `${at}.manifest ${JSON.stringify(unit.manifest)} is not inside its workingDirectory `
      + `${JSON.stringify(unit.workingDirectory)}. The command is declared to run from that `
      + `directory, so a manifest outside it is not what the toolchain would resolve.`,
    );
    need(
      world.trackedSet.has(String(unit.manifest)),
      `${at}.manifest ${JSON.stringify(unit.manifest)} is not tracked. A build declared to run from `
      + `${JSON.stringify(unit.workingDirectory)} with no manifest there does not resolve a project `
      + `at all.`,
    );

    // The command's own project-level claims, checked against the manifest.
    const command = unit.command ?? {};
    const argv = command.argv ?? [];
    if (command.program === "npm" && argv[0] === "run") {
      const script = String(argv[1] ?? "");
      const scripts = manifest(world, String(unit.manifest))?.scripts ?? {};
      need(
        Object.prototype.hasOwnProperty.call(scripts, script),
        `${at}.command runs \`npm run ${script}\`, but ${unit.manifest} declares no such script `
        + `(it declares ${JSON.stringify(Object.keys(scripts).sort())}). npm exits non-zero on a `
        + `missing script, so the deploy would fail at build time — after it had already decided a `
        + `release was worth rolling out.`,
      );
      need(
        argv.length <= 2 || argv[2] === "--",
        `${at}.command forwards ${JSON.stringify(argv.slice(2))} to \`npm run ${script}\` without a `
        + `\`--\` separator. npm would consume those as its OWN options and the build would silently `
        + `run with default settings.`,
      );
    }
    if (command.program === "npm" && argv[0] === "ci") {
      need(
        world.trackedSet.has(`${unit.workingDirectory}/package-lock.json`),
        `${at}.command runs \`npm ci\`, which REQUIRES a lockfile, but `
        + `${unit.workingDirectory}/package-lock.json is not tracked.`,
      );
    }
    if (command.program === "go" && argv[0] === "build") {
      need(
        argv[argv.length - 1] === ".",
        `${at}.command is ${JSON.stringify(argv)}; a \`go build\` declared to run from `
        + `${JSON.stringify(unit.workingDirectory)} must name the package as the trailing ".", or it `
        + `is not building the project that directory's manifest resolves.`,
      );
      need(
        String(unit.manifest).endsWith("/go.mod"),
        `${at}.command is a \`go build\` whose manifest is ${JSON.stringify(unit.manifest)}; want a `
        + `go.mod.`,
      );
    }
  }

  // Artifacts: nothing a build writes may be tracked, and every artifact must
  // land inside a tree the repository actually has.
  for (const artifact of contract.artifacts ?? []) {
    const at = `${CONTRACT_FILE}.artifacts[${JSON.stringify(artifact.id)}]`;
    const path = String(artifact.path);
    const tracked = world.trackedSet.has(path)
      || world.tracked.some((entry) => entry.startsWith(`${path}/`));
    need(
      artifact.gitTracked === tracked,
      `${at} declares gitTracked ${JSON.stringify(artifact.gitTracked)}, but Git ${tracked ? "tracks" : "does not track"} `
      + `${JSON.stringify(path)}. A build output that became a committed file is a deploy that `
      + `overwrites the working tree on every release.`,
    );
    const parent = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
    need(
      parent === "" || world.tracked.some((entry) => entry.startsWith(`${parent}/`)),
      `${at} lands in ${JSON.stringify(parent)}, which is not a tree this repository has. The deploy `
      + `path would create it, and nothing on this side describes what is in it.`,
    );
  }

  // Repository-root entries: the declared set must be exactly what Git has, and
  // each declared effect must be the one the build units DERIVE.
  const declared = (contract.repositoryRootEntries ?? []).map((entry) => entry.entry);
  const actual = sorted([...world.rootEntries]);
  need(
    deepEqual(sorted(declared), actual),
    `${CONTRACT_FILE}.repositoryRootEntries declares ${JSON.stringify(sorted(declared))}, but the `
    + `repository root holds ${JSON.stringify(actual)}. Every root entry has to be classified: the `
    + `deploy path rebuilds for some of them and silently records the rest as deployed without `
    + `building anything, and a new tree that nobody classified takes the silent branch by default.`,
  );
  for (const entry of contract.repositoryRootEntries ?? []) {
    // A representative real path under this entry: the entry itself when it is a
    // file, otherwise the first tracked file inside it. The effect is then
    // DERIVED by the same prefix rule the deploy script uses.
    const sample = world.trackedSet.has(entry.entry)
      ? entry.entry
      : world.tracked.find((path) => path.startsWith(`${entry.entry}/`));
    if (sample === undefined) continue; // covered by the set-equality rule above
    const units = unitsFor(contract, sample);
    const derived = units.length > 0 ? "rebuild" : "noRebuild";
    need(
      entry.effect === derived,
      `${CONTRACT_FILE}.repositoryRootEntries[${JSON.stringify(entry.entry)}] declares effect `
      + `${JSON.stringify(entry.effect)}, but the declared build inputs derive `
      + `${JSON.stringify(derived)} for ${JSON.stringify(sample)} (units ${JSON.stringify(units)}). `
      + `The column is a cross-check, not a second source of truth: whichever half moved, they no `
      + `longer describe the same deploy.`,
    );
  }
  return out;
}

// ── 3. the selective-build rule, evaluated against real tracked files ───────
//
// Not a table of hand-written paths compared to hand-written expectations: the
// paths come from `git ls-files`, so adding, moving or deleting a product source
// changes what these rules see.

function selectiveBuildFailures(world) {
  const out = [];
  const need = (ok, message) => { if (!ok) out.push(message); };
  const contract = world.contract;

  // Every declared input must actually start its own unit, which is what fails
  // when a prefix is narrowed, negated or removed. A `directoryPrefix` is judged
  // over every tracked file beneath it; a present `file` over that one path. An
  // input that starts nothing is a rebuild rule that is present and inert.
  for (const unit of contract.buildUnits ?? []) {
    const at = `${CONTRACT_FILE}.buildUnits[${JSON.stringify(unit.unit)}]`;
    for (const input of unit.inputs ?? []) {
      if (input.class === "directoryPrefix") {
        const members = world.tracked.filter((path) => path.startsWith(String(input.path)));
        need(
          members.length > 0,
          `${at} declares prefix ${JSON.stringify(input.path)}, which matches no tracked file.`,
        );
        const missed = members.filter((path) => !unitTriggeredBy(unit, path));
        need(
          missed.length === 0,
          `${missed.length} tracked files under ${JSON.stringify(input.path)} do not start the `
          + `${JSON.stringify(unit.unit)} build (e.g. ${JSON.stringify(missed[0])}). They would be `
          + `deployed as source with no rebuilt artifact behind them.`,
        );
      } else if (input.presence === "present") {
        need(
          unitsFor(contract, String(input.path)).includes(unit.unit),
          `${at} declares input ${JSON.stringify(input.path)}, but a change to that exact path `
          + `does not start it.`,
        );
      }
    }
  }

  // The npm reinstall inputs are a SUBSET of the Web build's, which is the shape
  // the deploy path relies on: a lockfile change reinstalls AND rebuilds. If the
  // two were disjoint, a dependency bump would install a new tree and ship the
  // old bundle.
  const web = (contract.buildUnits ?? []).find((unit) => unit.unit === "web");
  const deps = (contract.buildUnits ?? []).find((unit) => unit.unit === "webDependencies");
  if (web && deps) {
    for (const input of deps.inputs ?? []) {
      need(
        unitTriggeredBy(web, String(input.path)),
        `a change to ${JSON.stringify(input.path)} reinstalls the Web dependency tree but does NOT `
        + `start the Web build. The deploy would install new dependencies and then ship the bundle `
        + `built from the old ones.`,
      );
    }
    need(
      (deps.inputs ?? []).length > 0
      && (web.inputs ?? []).some((input) => !unitTriggeredBy(deps, String(input.path))),
      `every declared Web build input also reinstalls the dependency tree. The reinstall is minutes `
      + `of work on every source edit; it is declared narrowly on purpose.`,
    );
  }

  // Both directions of the rebuild-root boundary, because either alone is
  // vacuous. First: EVERY tracked file under a root classified `rebuild` must
  // actually start a build. "Every file under the declared prefix matches the
  // prefix" is a tautology — this is not, because the root comes from the
  // repository and the prefixes come from the contract, so narrowing `web/` to
  // `web/src/` leaves the rest of `web/` uncovered and fails here.
  const rebuildRoots = new Set(
    (contract.repositoryRootEntries ?? [])
      .filter((entry) => entry.effect === "rebuild")
      .map((entry) => entry.entry),
  );
  for (const root of sorted([...rebuildRoots])) {
    const members = world.tracked.filter((path) => path.startsWith(`${root}/`) || path === root);
    const uncovered = members.filter((path) => unitsFor(contract, path).length === 0);
    need(
      members.length > 0 && uncovered.length === 0,
      `${uncovered.length} of ${members.length} tracked files under the rebuild root `
      + `${JSON.stringify(root)} start NO build (e.g. ${JSON.stringify(uncovered[0] ?? null)}). The `
      + `deploy would ship them as source and rebuild nothing, and the commit would still be `
      + `recorded as deployed.`,
    );
  }

  // And the other direction: nothing outside those trees may start a build.
  // Anchored in the tracked file list, so a real product path moved under
  // `docs/` or `scripts/` fails here rather than being asserted about in the
  // abstract.
  const strays = world.tracked
    .filter((path) => !rebuildRoots.has(path.split("/")[0]))
    .filter((path) => unitsFor(contract, path).length > 0);
  need(
    strays.length === 0,
    `${strays.length} tracked paths outside the declared rebuild roots `
    + `${JSON.stringify(sorted([...rebuildRoots]))} still start a build (e.g. `
    + `${JSON.stringify(strays[0])}). A prefix that reaches outside its own tree makes the deploy `
    + `rebuild for documentation, CI or contract edits — the exact cost the selective rules exist to `
    + `avoid.`,
  );
  return out;
}

// ── 4. the documentation's consumer table agrees with the document ─────────
//
// Before this rule the consumer roll existed in several places and they
// disagreed: the document said `["go", "ops"]` — publishing a reader that did
// not exist and omitting the one running on every commit — and the contract
// doc restated that set in prose. Rule 2 above already holds the JSON to what
// actually runs. What is left is the one restatement a reader is most likely
// to trust instead of the JSON: the table in the contract's own documentation.
//
// The scope of this rule is exactly that: rows of the form `| \`id\` | status |`
// in `contract.documentation`, matched on those two columns. It reads no other
// file, no other column of this table, and no free-form sentence anywhere. A
// count, a caveat or an explanation written in English is documentation, not an
// input to this test. English is not a checkable interface: a rule over phrases
// in a hand-picked set of files would fail CI on an ordinary sentence inside
// them while a stale restatement in any file outside them went unnoticed — an
// arbitrary regex boundary rather than a closed contract.

function consumerTableFailures(world) {
  const out = [];
  const need = (ok, message) => { if (!ok) out.push(message); };
  const contract = world.contract;
  const consumers = contract.consumers ?? [];
  const doc = typeof contract.documentation === "string" ? contract.documentation : null;
  const text = doc === null ? null : source(world, doc);

  // A table row per consumer: `| \`id\` | status |`. Matched by both columns, so
  // a status that moved in the JSON and not in the table fails — which is the
  // precise shape of publishing a pending consumer as a current one.
  if (text !== null) {
    const statuses = (contract.vocabularies?.consumerStatuses ?? []).filter((term) => /^[a-z]+$/.test(term));
    const rows = new Map();
    if (statuses.length > 0) {
      const pattern = new RegExp(`^\\|\\s*\`([a-z][a-z0-9-]*)\`\\s*\\|\\s*(${statuses.join("|")})\\s*\\|`, "gm");
      for (const match of text.matchAll(pattern)) rows.set(match[1], match[2]);
    }
    for (const consumer of consumers) {
      need(
        rows.get(consumer?.id) === consumer?.status,
        `${doc}'s consumer table records ${JSON.stringify(consumer?.id)} as `
        + `${JSON.stringify(rows.get(consumer?.id) ?? null)}; ${CONTRACT_FILE} declares `
        + `${JSON.stringify(consumer?.status)}. That table is what a reader believes, and a `
        + `document that shows a pending consumer as current is the claim this column exists to `
        + `stop being makeable.`,
      );
    }
    for (const id of rows.keys()) {
      need(
        consumers.some((consumer) => consumer?.id === id),
        `${doc}'s consumer table has a row for ${JSON.stringify(id)}, which ${CONTRACT_FILE} does `
        + `not declare. A consumer that exists only in that table is one nobody can retire.`,
      );
    }
  }

  return out;
}

// ── 5. the proof that every rule above can still fail ───────────────────────
//
// Each case breaks ONE property in a copy of the real world and requires the
// matching complaint BY ITS OWN WORDING. "Something failed" would also be
// satisfied by a typo in an unrelated rule.

function clone(world) {
  return {
    contract: JSON.parse(JSON.stringify(world.contract)),
    tracked: [...world.tracked],
    trackedSet: new Set(world.trackedSet),
    rootEntries: new Set(world.rootEntries),
    untrackedExists: new Set(world.untrackedExists),
    manifests: new Map(world.manifests),
    sources: new Map(world.sources),
  };
}

const unit = (world, name) => world.contract.buildUnits.find((u) => u.unit === name);
const consumer = (world, id) => world.contract.consumers.find((c) => c.id === id);
/** The contract documentation's text in a mutated world, so a consumer-table
 *  row can be broken without editing the real page. */
const docText = (world) => source(world, world.contract.documentation);
const setDoc = (world, text) => { world.sources.set(world.contract.documentation, text); return world; };
const artifact = (world, id) => world.contract.artifacts.find((a) => a.id === id);
const endpoint = (world, id) => world.contract.healthEndpoints.find((e) => e.id === id);

const MUTATIONS = [
  // ── the shape ─────────────────────────────────────────────────────────────
  {
    name: "a top-level field is dropped",
    mutate: (w) => { delete w.contract.probe; return w; },
    expect: /declares top-level keys .*want exactly/s,
  },
  {
    name: "a top-level field nobody declared is added",
    mutate: (w) => { w.contract.deployHook = "curl https://example.invalid"; return w; },
    expect: /declares top-level keys .*deployHook.*want exactly/s,
  },
  {
    name: "the top-level fields are reordered",
    mutate: (w) => {
      const { contract, contractVersion, ...rest } = w.contract;
      w.contract = { contractVersion, contract, ...rest };
      return w;
    },
    expect: /want exactly .*in that order/s,
  },
  {
    name: "a field has the wrong type",
    mutate: (w) => { w.contract.listener.defaultPort = "8080"; return w; },
    expect: /listener\.defaultPort is "8080"/,
  },
  {
    name: "a list is reordered",
    mutate: (w) => {
      w.contract.consumers = [consumer(w, "ops"), consumer(w, "go"), consumer(w, "product-policy")];
      return w;
    },
    expect: /declares consumers \["ops","go","product-policy"\]; want a non-empty, sorted, duplicate-free list of ids/,
  },
  {
    name: "a list gains a duplicate",
    mutate: (w) => { w.contract.probe.methods = [...w.contract.probe.methods, "PUT"]; return w; },
    expect: /probe\.methods is .*want a non-empty, sorted, duplicate-free list of upper-case/s,
  },
  {
    name: "a vocabulary gains a term nothing uses",
    mutate: (w) => { w.contract.vocabularies.programs = ["cargo", "go", "npm"]; return w; },
    expect: /vocabularies\.programs declares \["cargo"\], which nothing in this contract uses/,
  },

  // ── closed vocabularies and cross-references ──────────────────────────────
  {
    name: "an input declares a path class no consumer knows",
    mutate: (w) => { unit(w, "web").inputs[0].class = "glob"; return w; },
    expect: /has path class "glob", which is not in vocabularies\.inputClasses/,
  },
  {
    name: "a directory prefix loses its trailing slash",
    mutate: (w) => {
      unit(w, "web").inputs[0].path = "web";
      return w;
    },
    expect: /is a directoryPrefix that does not end in "\/"/,
  },
  {
    name: "a placeholder is not a whole argv element",
    mutate: (w) => {
      const command = unit(w, "web").command;
      command.argv = command.argv.map((arg) => (arg === "{{webReleaseStage}}" ? "--outDir={{webReleaseStage}}" : arg));
      return w;
    },
    expect: /which is not a whole-element placeholder/,
  },
  {
    name: "a placeholder names an artifact that does not exist",
    mutate: (w) => {
      const command = unit(w, "server").command;
      command.argv = command.argv.map((arg) => (arg === "{{serverCandidateBinary}}" ? "{{serverStagingBinary}}" : arg));
      return w;
    },
    expect: /names placeholder \{\{serverStagingBinary\}\}, which is not a declared artifact id/,
  },
  {
    name: "the output flag no longer sits next to the path it names",
    mutate: (w) => {
      const command = unit(w, "web").command;
      command.argv = ["run", "build", "--", "--outDir", "--emptyOutDir", "{{webReleaseStage}}"];
      return w;
    },
    expect: /output flag "--outDir" is not immediately followed by its placeholder/,
  },
  {
    name: "the output flag is renamed in argv but not in the contract field",
    mutate: (w) => {
      const command = unit(w, "web").command;
      command.argv = command.argv.map((arg) => (arg === "--outDir" ? "--out-dir" : arg));
      return w;
    },
    expect: /declares outputFlag "--outDir", which appears 0 times/,
  },
  {
    name: "an artifact and its producing unit disagree about who writes it",
    mutate: (w) => { artifact(w, "webReleaseStage").producedBy = "server"; return w; },
    expect: /producedBy is "server", but the units declaring it in `produces` are \["web"\]/,
  },
  {
    name: "the missing-output recovery rule names an artifact nobody declared",
    mutate: (w) => { unit(w, "server").rebuildWhenMissing = "serverArchive"; return w; },
    expect: /rebuildWhenMissing is "serverArchive", which is not a declared artifact/,
  },
  {
    name: "a readiness failure mode is declared with no status to report it",
    mutate: (w) => { endpoint(w, "readiness").failureStatus = null; return w; },
    expect: /failure modes and failureStatus null\. Want null with no modes, and 503 with any/,
  },
  {
    name: "the database ping loses its declared bound",
    mutate: (w) => { endpoint(w, "readiness").databaseTimeoutMilliseconds = null; return w; },
    expect: /databaseTimeoutMilliseconds is null, which does not match its failure modes/,
  },
  {
    name: "a health route grows a trailing slash and becomes a subtree",
    mutate: (w) => { endpoint(w, "readiness").path = "/readyz/"; return w; },
    expect: /want an absolute path with no trailing slash/,
  },
  {
    name: "the listener's address and its port drift apart",
    mutate: (w) => { w.contract.listener.defaultAddress = ":9090"; return w; },
    expect: /defaultPort is 8080 but its defaultAddress ":9090" resolves to 9090/,
  },
  {
    name: "a path the contract says is dead is listed as a live health route",
    mutate: (w) => { w.contract.probe.nonMatchingPaths = ["/", "/readyz"]; return w; },
    expect: /nonMatchingPaths contains "\/readyz", which is also a health endpoint path/,
  },

  // ── the consumer roll: status, readers, and the doc's table of them ───────
  //
  // The defect these prove is not hypothetical. This document shipped with
  // `["go", "ops"]`: a flat list that published a reader which did not exist and
  // omitted the one running on every commit.
  {
    name: "a consumer gains a field nobody declared",
    mutate: (w) => { consumer(w, "go").enforced = true; return w; },
    expect: /consumers\["go"\] declares keys .*enforced.*want exactly/s,
  },
  {
    name: "a consumer id is declared twice",
    mutate: (w) => {
      w.contract.consumers = [consumer(w, "go"), consumer(w, "go"), consumer(w, "ops")];
      return w;
    },
    expect: /declares consumers \["go","go","ops"\]; want a non-empty, sorted, duplicate-free list of ids/,
  },
  {
    name: "a consumer takes a status outside the closed vocabulary",
    mutate: (w) => { consumer(w, "ops").status = "planned"; return w; },
    expect: /consumers\["ops"\]\.status is "planned", which is not in vocabularies\.consumerStatuses/,
  },
  {
    // The exact lie the flat list told: enforcement that does not exist yet,
    // recorded as current.
    name: "the pending ops consumer is published as active",
    mutate: (w) => { consumer(w, "ops").status = "active"; return w; },
    expect: /consumers\["ops"\] is active but names no reader/,
  },
  {
    name: "a reader that runs is recorded as pending",
    mutate: (w) => { consumer(w, "go").status = "pending"; return w; },
    expect: /consumers\["go"\] is pending but names reader "server\/ops_deploy_contract_test\.go"/,
  },
  {
    // The other half of the same defect: the always-on reader left off the roll.
    name: "the reader that runs on every commit is dropped from the roll",
    mutate: (w) => {
      w.contract.consumers = w.contract.consumers.filter((c) => c.id !== "product-policy");
      return w;
    },
    expect: /scripts\/test\/ops-deploy-contract-test\.mjs reads contracts\/ops-deploy-v1\.json on every run, but .* declares no active entry/s,
  },
  {
    name: "an active reader stops opening the document",
    mutate: (w) => {
      w.sources.set(GO_CONSUMER, "package main\n// nothing here opens a document\n");
      return w;
    },
    expect: /does not name contracts\/ops-deploy-v1\.json verbatim/,
  },
  {
    name: "an active reader is renamed in the document but not on disk",
    mutate: (w) => { consumer(w, "go").reader = "server/ops_contract_test.go"; return w; },
    expect: /names reader "server\/ops_contract_test\.go" in this repository, which Git does not track/,
  },
  {
    name: "the external reader is pointed at a path this repository resolves",
    mutate: (w) => {
      const ops = consumer(w, "ops");
      ops.status = "active";
      ops.reader = SELF_CONSUMER;
      return w;
    },
    expect: /places reader "scripts\/test\/ops-deploy-contract-test\.mjs" in "relayium-ops", but this repository tracks that exact path/,
  },
  {
    name: "the doc keeps a status the document has moved on from",
    mutate: (w) => setDoc(w, docText(w).replace("| `ops` | pending |", "| `ops` | active |")),
    expect: /consumer table records "ops" as "active"; contracts\/ops-deploy-v1\.json declares "pending"/,
  },
  {
    name: "the doc lists a consumer the document does not declare",
    mutate: (w) => setDoc(w, `${docText(w)}\n| \`swift\` | active | \`relayium\` | none |\n`),
    expect: /consumer table has a row for "swift", which contracts\/ops-deploy-v1\.json does not declare/,
  },

  // ── the wire, not the handler ─────────────────────────────────────────────
  //
  // `probe.methods` includes HEAD and the contract freezes a success body. Go's
  // net/http withholds a HEAD entity body at the server, so both of the rules
  // below stand between the document and the claim that `HEAD /readyz` answers
  // `ready` when a real client receives nothing.
  {
    name: "HEAD is dropped from the bodyless list, restoring the claim that a HEAD probe reads the body",
    mutate: (w) => { w.contract.probe.bodylessMethods = []; return w; },
    expect: /probe\.bodylessMethods is \[\]; want \["HEAD"\]/,
  },
  {
    name: "a method the transport does not suppress is declared bodyless",
    mutate: (w) => { w.contract.probe.bodylessMethods = ["GET", "HEAD"]; return w; },
    expect: /probe\.bodylessMethods is \["GET","HEAD"\]; want \["HEAD"\]/,
  },
  {
    // Reverting the method case to a ResponseRecorder is the specific way this
    // becomes green-but-false again: the recorder holds the body net/http
    // suppresses in transit.
    name: "the runtime half stops driving a real server and judges the wire through a recorder",
    mutate: (w) => {
      w.sources.set(GO_CONSUMER, source(w, GO_CONSUMER).replaceAll("httptest.NewServer", "httptest.NewRecorder"));
      return w;
    },
    expect: /never constructs an httptest\.NewServer/,
  },

  // ── the repository on disk ────────────────────────────────────────────────
  {
    name: "a declared build input is removed from the repository",
    mutate: (w) => {
      w.tracked = w.tracked.filter((path) => path !== "web/package-lock.json");
      w.trackedSet.delete("web/package-lock.json");
      return w;
    },
    expect: /declares "web\/package-lock\.json" as a PRESENT build input, but Git tracks nothing there/,
  },
  {
    name: "a root go.mod appears, so the server's inert prefix becomes live",
    mutate: (w) => {
      w.tracked = sorted([...w.tracked, "go.mod"]);
      w.trackedSet.add("go.mod");
      w.rootEntries.add("go.mod");
      return w;
    },
    expect: /declares "go\.mod" as ABSENT, but the repository has it/,
  },
  {
    name: "a build's working directory moves away from its manifest",
    mutate: (w) => { unit(w, "web").workingDirectory = "."; return w; },
    expect: /is not inside its workingDirectory "\."/,
  },
  {
    name: "the Web build invokes an npm script package.json does not declare",
    mutate: (w) => {
      const command = unit(w, "web").command;
      command.argv = command.argv.map((arg, i) => (i === 1 ? "bundle" : arg));
      return w;
    },
    expect: /runs `npm run bundle`, but web\/package\.json declares no such script/,
  },
  {
    name: "the forwarded build flags lose their `--` separator",
    mutate: (w) => {
      const command = unit(w, "web").command;
      command.argv = command.argv.filter((arg) => arg !== "--");
      return w;
    },
    expect: /without a `--` separator/,
  },
  {
    name: "the server build stops naming the package in its working directory",
    mutate: (w) => {
      const command = unit(w, "server").command;
      command.argv = command.argv.filter((arg) => arg !== ".");
      return w;
    },
    expect: /must name the package as the trailing "\."/,
  },
  {
    name: "a build output becomes a committed file",
    mutate: (w) => {
      w.tracked = sorted([...w.tracked, "server/relayium-server"]);
      w.trackedSet.add("server/relayium-server");
      return w;
    },
    expect: /declares gitTracked false, but Git tracks "server\/relayium-server"/,
  },
  {
    name: "an artifact is moved into a tree the repository does not have",
    mutate: (w) => { artifact(w, "webNodeModules").path = "vendor/node_modules"; return w; },
    expect: /lands in "vendor", which is not a tree this repository has/,
  },

  // ── the selective-build rule ──────────────────────────────────────────────
  {
    name: "a new repository-root tree lands unclassified",
    mutate: (w) => {
      w.tracked = sorted([...w.tracked, "cli/main.go"]);
      w.trackedSet.add("cli/main.go");
      w.rootEntries.add("cli");
      return w;
    },
    expect: /but the repository root holds .*"cli"/s,
  },
  {
    name: "a classified root entry is deleted from the repository",
    mutate: (w) => {
      w.tracked = w.tracked.filter((path) => !path.startsWith("docs/"));
      w.trackedSet = new Set(w.tracked);
      w.rootEntries.delete("docs");
      return w;
    },
    expect: /repositoryRootEntries declares .*"docs".*but the repository root holds/s,
  },
  {
    name: "a root entry's declared effect stops matching what the inputs derive",
    mutate: (w) => {
      w.contract.repositoryRootEntries.find((entry) => entry.entry === "docs").effect = "rebuild";
      return w;
    },
    expect: /repositoryRootEntries\["docs"\] declares effect "rebuild", but the declared build inputs derive "noRebuild"/,
  },
  {
    name: "the Web build prefix is narrowed off part of its own tree",
    mutate: (w) => { unit(w, "web").inputs[0].path = "web/src/"; return w; },
    expect: /tracked files under the rebuild root "web" start NO build/,
  },
  {
    name: "the server build prefix is dropped entirely",
    mutate: (w) => {
      const server = unit(w, "server");
      server.inputs = server.inputs.filter((input) => input.path !== "server/");
      return w;
    },
    expect: /repositoryRootEntries\["server"\] declares effect "rebuild", but the declared build inputs derive "noRebuild"/,
  },
  {
    name: "the dependency reinstall stops implying a rebuild",
    mutate: (w) => { unit(w, "web").inputs[0].path = "web/src/"; return w; },
    expect: /reinstalls the Web dependency tree but does NOT start the Web build/,
  },
  {
    name: "the reinstall rule widens to the whole Web tree",
    mutate: (w) => {
      const deps = unit(w, "webDependencies");
      deps.inputs = [{ path: "web/", class: "directoryPrefix", presence: "present" }];
      return w;
    },
    expect: /every declared Web build input also reinstalls the dependency tree/,
  },
  {
    name: "a build prefix reaches outside its own tree",
    mutate: (w) => {
      const server = unit(w, "server");
      server.inputs = sorted([...server.inputs.map((i) => i.path), "docs/"])
        .map((path) => server.inputs.find((i) => i.path === path)
          ?? { path, class: "directoryPrefix", presence: "present" });
      return w;
    },
    expect: /tracked paths outside the declared rebuild roots .*still start a build/s,
  },
];

// ── run ─────────────────────────────────────────────────────────────────────

const RULES = [schemaFailures, repositoryFailures, selectiveBuildFailures, consumerTableFailures];
const judge = (world) => RULES.flatMap((rule) => rule(world));

let world;
try {
  world = loadWorld();
} catch (error) {
  console.error(`ops-deploy-contract-test: could not load the world: ${error.message}`);
  process.exit(1);
}
// Warm the manifest and source caches so a mutation reasons over the same parse
// and the same text this run judged.
for (const buildUnit of world.contract.buildUnits ?? []) manifest(world, String(buildUnit.manifest));
if (typeof world.contract.documentation === "string") source(world, world.contract.documentation);
for (const consumer of world.contract.consumers ?? []) {
  if (typeof consumer?.reader === "string") source(world, consumer.reader);
}

for (const message of judge(world)) check(false, message);

let mutationsProven = 0;
for (const mutation of MUTATIONS) {
  let messages;
  try {
    messages = judge(mutation.mutate(clone(world)));
  } catch (error) {
    check(false, `the mutation "${mutation.name}" could not be applied: ${error.message}. A mutation `
      + `that stopped applying leaves the world unbroken and its case passes while asserting nothing.`);
    continue;
  }
  if (messages.some((message) => mutation.expect.test(message))) {
    mutationsProven++;
    continue;
  }
  check(false, `the ops deploy contract policy did NOT complain about "${mutation.name}". Expected a `
    + `message matching ${mutation.expect}; got [\n    ${messages.join("\n    ") || "nothing"}\n  ]. `
    + `A check that cannot fail for the reason it was written is not a check.`);
}

if (failures.length > 0) {
  console.error("ops-deploy-contract-test: FAILED\n");
  for (const failure of failures) console.error(`  ✗ ${failure}\n`);
  process.exit(1);
}

const consumerRoll = (world.contract.consumers ?? [])
  .map((entry) => `${entry.id}=${entry.status}`)
  .join(", ");
console.log(
  `ops-deploy-contract-test: OK (${CONTRACT_FILE} is closed and ordered over `
  + `${world.contract.buildUnits.length} build units, ${world.contract.artifacts.length} artifacts, `
  + `${world.contract.repositoryRootEntries.length} classified root entries and `
  + `${world.contract.healthEndpoints.length} health endpoints; every declared path, working `
  + `directory, npm script and artifact re-checked against ${world.tracked.length} tracked files; `
  + `consumers ${consumerRoll}, each active reader re-opened on disk, and every id/status pair `
  + `matched against ${world.contract.documentation}'s consumer table; ${mutationsProven} `
  + `mutations prove each rule can fail)`,
);
