#!/usr/bin/env node
// The macOS publication HANDOFF: what `macos-release.yml`'s publish job leaves
// behind in `metadata_delivery=operator` mode, and the read-only verifier an
// authorized operator runs before each of the two writes the job did not make.
//
// Why this exists. macOS 1.4.5 (42) was notarized, its metadata candidate
// passed a full merge-gate, and then the job's own `git push origin
// <candidate>:main` was refused with GH006 — the cause is UNKNOWN and nothing
// here asserts one. A later `gh release create` returned 403 and was recovered
// by an existing administrator. The publication preflight could only prove the
// read-only contract; it cannot prove that this token may push or create a
// release without doing it. So the default delivery is now: do every check and
// every derivation the job can do, push only a uniquely named candidate branch,
// dispatch and identify its frozen gate, write an immutable record of exactly
// what was built and judged, and STOP — "HANDED OFF / NOT PUBLISHED". The
// operator then advances main and creates the release with their existing
// authority, each step preceded by `verify` below.
//
// Nothing in this file writes to GitHub. `verify` reads the API, local Git and
// the downloaded artifact files, and prints a verdict; it never pushes, tags or
// creates anything. A record is NOT trusted as a claim: every field the verifier
// relies on is re-read from an authoritative source and compared.
//
// Reuses `macos-evidence.mjs` for the API client, pagination, changed-path
// parsing and the gate-run judge rather than growing a second copy of each.

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  closeSync, constants as fsConstants, fstatSync, lstatSync, mkdtempSync, openSync, readFileSync, realpathSync, rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  ACTIONS_APP_ID,
  ADOPTED_SHAPE,
  AUXILIARY_JOBS,
  CERTIFY_JOB,
  COVERAGE_CERTIFIED,
  COVERAGE_EXECUTED,
  EVENT_CONTRACT_SHAPE,
  EVIDENCE_JOB,
  EVIDENCE_SCHEMA,
  EXPECTED_JOBS,
  PAYLOAD_FILES,
  PROVENANCE_SCHEMA,
  Refused,
  TEAM_ID,
  WITNESSED_CONTRACT_SHAPE,
  changedPaths,
  coverageOf,
  entryKind,
  Unavailable,
  findGateRun,
  githubApi,
  judgeExecutionOrigin,
  judgeProducerRoster,
  judgeGateRun,
  paginate,
  readProducerShape,
  readZipEntries,
  unsafeNameReason,
  validateCoverage,
  verifyHistoricalCertifiedCoverage,
} from "./macos-evidence.mjs";
import { artifactIdentityOf, isArtifactIdentity, readSingleEntryZip } from "../ci/ci-evidence.mjs";

const PRODUCER_PATH = ".github/workflows/macos.yml";
const PUBLISHER_PATH = ".github/workflows/macos-release.yml";
/**
 * v2 — what every new handoff is: v1's fields plus `signedBuild`, the exact
 * signed-build chain the notarization consumed (see `judgeSignedBuild`).
 * v1 — records written before it: still parsed and verified exactly as they
 * were, executed-only. A v1 record is never read as carrying a certified chain.
 */
export const HANDOFF_SCHEMA = "relayium-macos-publication-handoff/v2";
export const HANDOFF_SCHEMA_V1 = "relayium-macos-publication-handoff/v1";
/** `signedBuild.kind`: the publisher's own `build / ` call, or a reused `macos.yml` push run on main. */
export const SIGNED_BUILD_KINDS = Object.freeze(["publisher-build", "main-push"]);
const PRODUCER_SHAPES = Object.freeze(["legacy", ADOPTED_SHAPE, EVENT_CONTRACT_SHAPE, WITNESSED_CONTRACT_SHAPE]);
export const DELIVERY_MODES = Object.freeze(["operator", "workflow"]);
export const STAGES = Object.freeze(["main", "release"]);

/** The five files the publish job derives from the notarized artifact. */
export const DERIVED_FILES = Object.freeze([
  "web/native-releases.json",
  "web/native-client-policy.json",
  "web/public/apps/macos/appcast.xml",
  "web/public/apps/macos/client-policy.json",
  "server/account/macos_release_catalog.json",
]);

/** Where each derived file sits inside the notarized release artifact. */
export const ARTIFACT_PATHS = Object.freeze({
  "web/native-releases.json": "release-web/native-releases.json",
  "web/native-client-policy.json": "release-web/native-client-policy.json",
  "web/public/apps/macos/appcast.xml": "release-web/public/apps/macos/appcast.xml",
  "web/public/apps/macos/client-policy.json": "release-web/public/apps/macos/client-policy.json",
  "server/account/macos_release_catalog.json": "server/account/macos_release_catalog.json",
});

/** Release assets, in the order `gh release create` uploads them. */
export const RELEASE_ASSETS = Object.freeze(["Relayium.dmg", "Relayium.dmg.sha256", "appcast.xml"]);

/**
 * Native inputs: a path under `apps/` other than `apps/README.md`. Between the
 * notarized source commit and the candidate, nothing that could change the
 * shipped binary may differ — otherwise the published metadata describes a
 * build of different sources than the one notarized.
 */
export function isNativeInput(path) {
  return path.startsWith("apps/") && path !== "apps/README.md";
}

const SHA40 = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const VERSION = /^[0-9]+(?:\.[0-9]+){1,2}$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const refuse = (ok, message) => { if (!ok) throw new Refused(message); };

// ── the workflows-directory comparison (preflight) ──────────────────────────

/**
 * The tree SHA of `.github/workflows` at `commit`, walked one level at a time
 * through the Git database API. Non-recursive tree reads cannot be truncated
 * in the way a recursive listing can, but a `truncated: true` answer is still
 * refused rather than trusted, as is any missing or ambiguous entry.
 */
export async function workflowsTree(api, repository, commit) {
  refuse(SHA40.test(commit ?? ""), `workflows tree: ${JSON.stringify(commit)} is not a commit SHA`);
  const c = await api.get(`/repos/${repository}/git/commits/${commit}`);
  refuse(c?.sha === commit && SHA40.test(c?.tree?.sha ?? ""), `commit ${commit} returned no usable tree`);
  let tree = c.tree.sha;
  for (const name of [".github", "workflows"]) {
    const body = await api.get(`/repos/${repository}/git/trees/${tree}`);
    refuse(body?.sha === tree && Array.isArray(body?.tree), `tree ${tree} is not a readable tree`);
    refuse(body.truncated === false, `tree ${tree} was truncated; the comparison is unknown`);
    const hits = body.tree.filter((e) => e?.path === name);
    refuse(hits.length === 1 && hits[0].type === "tree" && SHA40.test(hits[0].sha ?? ""),
      `commit ${commit} has no single ${name} tree`);
    tree = hits[0].sha;
  }
  return tree;
}

/**
 * Compare the source commit's and main's `.github/workflows` trees. Documented
 * GitHub behavior refuses a GITHUB_TOKEN write that would put workflow files
 * the token's run did not start from; a mismatch is therefore a KNOWN
 * condition under which the workflow-mode writes may be refused (a 403 on
 * release creation was observed). It is not proof of either outcome, and a
 * match does NOT prove the token may push.
 */
export async function compareWorkflows(api, { repository, sha, mode }) {
  refuse(DELIVERY_MODES.includes(mode), `metadata_delivery ${JSON.stringify(mode)} is not one of ${DELIVERY_MODES.join("/")}`);
  const main = await api.get(`/repos/${repository}/git/ref/heads/main`);
  refuse(SHA40.test(main?.object?.sha ?? "") && main?.object?.type === "commit", "main does not resolve to a commit");
  const source = await workflowsTree(api, repository, sha);
  const current = await workflowsTree(api, repository, main.object.sha);
  const match = source === current;
  if (!match && mode === "workflow") {
    throw new Refused(`the source ${sha} and main ${main.object.sha} carry different .github/workflows trees `
      + `(${source} vs ${current}); workflow-mode delivery is refused before the paid build. `
      + "Use metadata_delivery=operator, or dispatch from the current main.");
  }
  return { main: main.object.sha, source, current, match };
}

// ── the record ──────────────────────────────────────────────────────────────

const SHAPE = {
  schema: "string",
  repository: { id: "integer", name: "string" },
  release: { version: "string", build: "integer", channel: "string", architectures: "array", tag: "string" },
  source: { sha: "string", workflowsTree: "string" },
  publisher: { runId: "integer", attempt: "integer", workflow: "string" },
  artifact: {
    id: "integer", name: "string", digest: "string", createdAt: "string", expiresAt: "string", workflowRunId: "integer",
  },
  dmg: { sha256: "string", provenanceSha: "string", notarized: "boolean" },
  candidate: {
    state: "string", base: "string|null", head: "string|null", tree: "string|null",
    branch: "string|null", changedPaths: "array",
  },
  derived: "object",
  gate: { runId: "integer|null", attempt: "integer|null", dispatchedAt: "string|null" },
  releasePlan: { title: "string", notes: "string", assets: "array", target: "string", latest: "boolean" },
  handedOffAt: "string",
};
const SHAPE_V2 = { ...SHAPE, signedBuild: "object" };

function typeOk(value, want) {
  return want.split("|").some((t) => (t === "null" ? value === null
    : t === "integer" ? Number.isInteger(value)
      : t === "array" ? Array.isArray(value)
        : t === "object" ? value !== null && typeof value === "object" && !Array.isArray(value)
          : typeof value === t));
}

function checkShape(value, shape, where) {
  if (typeof shape === "string") {
    refuse(typeOk(value, shape), `handoff ${where} is not ${shape}`);
    return;
  }
  refuse(value !== null && typeof value === "object" && !Array.isArray(value), `handoff ${where} is not an object`);
  const want = Object.keys(shape).sort();
  const have = Object.keys(value).sort();
  refuse(JSON.stringify(want) === JSON.stringify(have),
    `handoff ${where} has keys [${have.join(", ")}]; the schema requires exactly [${want.join(", ")}]`);
  for (const key of want) checkShape(value[key], shape[key], `${where}.${key}`.replace(/^\./, ""));
}

/** Strict parse: exact keys, exact types, and the value constraints below. */
export function parseHandoff(text) {
  let record;
  try {
    record = JSON.parse(text);
  } catch (error) {
    throw new Refused(`the handoff record is not JSON: ${error.message}`);
  }
  refuse(record !== null && typeof record === "object" && !Array.isArray(record), "the handoff record is not an object");
  refuse(record.schema === HANDOFF_SCHEMA || record.schema === HANDOFF_SCHEMA_V1,
    `handoff schema ${JSON.stringify(record.schema)} is not ${HANDOFF_SCHEMA} or ${HANDOFF_SCHEMA_V1}`);
  const v2 = record.schema === HANDOFF_SCHEMA;
  checkShape(record, v2 ? SHAPE_V2 : SHAPE, "");
  refuse(record.repository.id > 0, "handoff repository.id is not positive");
  refuse(VERSION.test(record.release.version), "handoff release.version is not a version");
  refuse(record.release.build > 0, "handoff release.build is not positive");
  refuse(record.release.channel === "stable", "handoff release.channel is not stable");
  refuse(JSON.stringify(record.release.architectures) === '["arm64"]', "handoff architectures are not exactly [arm64]");
  refuse(record.release.tag === `macos-v${record.release.version}`, "handoff tag does not name its version");
  refuse(SHA40.test(record.source.sha) && SHA40.test(record.source.workflowsTree), "handoff source SHAs are malformed");
  refuse(record.publisher.runId > 0 && record.publisher.attempt > 0, "handoff publisher run is malformed");
  refuse(record.publisher.workflow === ".github/workflows/macos-release.yml", "handoff publisher workflow is not macos-release.yml");
  refuse(record.artifact.name === `relayium-macos-${record.source.sha}-${record.release.version}`,
    "handoff artifact name does not bind the source commit and version");
  refuse(/^sha256:[0-9a-f]{64}$/.test(record.artifact.digest), "handoff artifact digest is malformed");
  refuse(ISO.test(record.artifact.expiresAt) && ISO.test(record.artifact.createdAt) && ISO.test(record.handedOffAt),
    "handoff timestamps are malformed");
  refuse(record.artifact.workflowRunId === record.publisher.runId, "handoff artifact is not the publisher run's");
  refuse(SHA256.test(record.dmg.sha256) && record.dmg.notarized === true && record.dmg.provenanceSha === record.source.sha,
    "handoff DMG identity is malformed or not notarized from the source commit");
  const cand = record.candidate;
  refuse(["frozen", "already-delivered"].includes(cand.state), `handoff candidate.state ${JSON.stringify(cand.state)} is unknown`);
  if (cand.state === "frozen") {
    refuse(SHA40.test(cand.base ?? "") && SHA40.test(cand.head ?? "") && SHA40.test(cand.tree ?? ""),
      "a frozen handoff candidate needs base/head/tree SHAs");
    refuse(cand.branch === `release-candidate/${record.release.tag}-${record.publisher.runId}-${record.publisher.attempt}`,
      "handoff candidate branch does not bind the tag and publisher run/attempt");
    refuse(cand.changedPaths.length > 0 && cand.changedPaths.every((p) => typeof p === "string"),
      "a frozen handoff candidate lists no changed paths");
    refuse(Number.isInteger(record.gate.runId) && Number.isInteger(record.gate.attempt) && ISO.test(record.gate.dispatchedAt ?? ""),
      "a frozen handoff candidate has no identified gate run");
  } else {
    // `base` is the main commit that already carried the metadata when the
    // record was written: the release stage binds to it, not to "whatever main
    // is now".
    refuse(SHA40.test(cand.base ?? "") && cand.head === null && cand.tree === null && cand.branch === null
      && cand.changedPaths.length === 0, "an already-delivered handoff must name the main it found and carry no candidate");
    refuse(record.gate.runId === null && record.gate.attempt === null && record.gate.dispatchedAt === null,
      "an already-delivered handoff must carry no gate run");
  }
  refuse(JSON.stringify(Object.keys(record.derived).sort()) === JSON.stringify([...DERIVED_FILES].sort())
    && Object.values(record.derived).every((v) => typeof v === "string" && SHA256.test(v)),
  "handoff derived must hash exactly the five derived files");
  const plan = record.releasePlan;
  refuse(plan.latest === false, "handoff releasePlan.latest must be false");
  refuse(plan.target === record.source.sha, "handoff release target is not the notarized source commit");
  refuse(JSON.stringify(plan.assets) === JSON.stringify(RELEASE_ASSETS), "handoff release assets are not exactly the three originals");
  refuse(plan.title === `Relayium for macOS ${record.release.version}`, "handoff release title is not the canonical one");
  // The notes are the publisher run's canonical text and nothing else: a
  // record is not a channel for instructions to whoever creates the release.
  refuse(plan.notes === releaseNotes(record.publisher.runId), "handoff release notes are not the canonical notes of the publisher run");
  if (v2) parseSignedBuild(record);
  return record;
}

const SIGNED_BUILD_KEYS = ["coverage", "decision", "execution", "kind", "originalAttempt", "runId", "shape", "signedArtifact"];
const DECISION_KEYS = ["attempt", "decidedAt", "identity", "mode", "preflight"];
const DECISION_MODES = Object.freeze(["auto", "reuse"]);

/** The preflight's uploaded decision artifact for `sha` at one attempt. */
export const decisionArtifactName = (sha, attempt) => `relayium-macos-build-source-${sha}-attempt-${attempt}`;

/**
 * `signedBuild`, strictly: exact keys and types, and every binding the record
 * can state about itself. Authenticity is `judgeSignedBuild`'s.
 *  - publisher-build: the publisher run's own `build / ` call — executed
 *    coverage only, no reuse decision.
 *  - main-push: a `macos.yml` push run on main, reused through the
 *    publisher preflight's decision artifact, whose complete identity (the
 *    ten-field artifact record), attempt and preflight execution are frozen;
 *    its coverage is `{ mode: executed }` or a complete certified chain whose
 *    witness attempt IS the signed build's original attempt.
 */
function parseSignedBuild(record) {
  const sb = record.signedBuild;
  refuse(JSON.stringify(Object.keys(sb).sort()) === JSON.stringify(SIGNED_BUILD_KEYS),
    `handoff signedBuild has keys [${Object.keys(sb).sort().join(", ")}]; the schema requires exactly [${SIGNED_BUILD_KEYS.join(", ")}]`);
  refuse(SIGNED_BUILD_KINDS.includes(sb.kind), `handoff signedBuild.kind ${JSON.stringify(sb.kind)} is unknown`);
  refuse(Number.isSafeInteger(sb.runId) && sb.runId > 0 && Number.isSafeInteger(sb.originalAttempt) && sb.originalAttempt > 0,
    "handoff signedBuild run/attempt is malformed");
  refuse(typeof sb.execution === "string" && SHA256.test(sb.execution), "handoff signedBuild.execution is not a sha256");
  refuse(PRODUCER_SHAPES.includes(sb.shape), `handoff signedBuild.shape ${JSON.stringify(sb.shape)} is unknown`);
  try {
    validateCoverage(sb.coverage);
  } catch (error) {
    throw new Refused(`handoff signedBuild.coverage: ${error.message}`);
  }
  if (sb.kind === "publisher-build") {
    refuse(sb.runId === record.publisher.runId && sb.originalAttempt <= record.publisher.attempt,
      "a publisher-build signed build is not the publisher run's own");
    refuse(sb.coverage.mode === COVERAGE_EXECUTED, "a publisher-build signed build can only be executed coverage");
    refuse(sb.decision === null && sb.signedArtifact === null, "a publisher-build signed build carries no reuse decision or reused artifact");
    return;
  }
  refuse(sb.runId !== record.publisher.runId, "a main-push signed build cannot be the publisher run");
  refuse(sb.coverage.mode === COVERAGE_EXECUTED || sb.shape === ADOPTED_SHAPE || sb.shape === EVENT_CONTRACT_SHAPE,
    `a certified coverage cannot describe a ${sb.shape} producer`);
  const sa = sb.signedArtifact;
  refuse(sa !== null && typeof sa === "object" && !Array.isArray(sa) && sorted(sa) === '["digest","id","name"]'
    && Number.isSafeInteger(sa.id) && sa.id > 0 && sa.name === `relayium-macos-signed-${record.source.sha}-ci`
    && /^sha256:[0-9a-f]{64}$/.test(sa.digest ?? ""), "handoff signedBuild.signedArtifact is not the reused signed artifact of the source commit");
  const d = sb.decision;
  refuse(d !== null && typeof d === "object" && !Array.isArray(d)
    && JSON.stringify(Object.keys(d).sort()) === JSON.stringify(DECISION_KEYS),
  `handoff signedBuild.decision must have exactly [${DECISION_KEYS.join(", ")}]`);
  refuse(Number.isSafeInteger(d.attempt) && d.attempt > 0 && d.attempt <= record.publisher.attempt,
    "handoff decision attempt is not an attempt of the publisher run");
  refuse(isArtifactIdentity(d.identity), "handoff decision identity is not one complete artifact identity");
  const id = d.identity;
  refuse(id.name === decisionArtifactName(record.source.sha, d.attempt) && id.run_id === record.publisher.runId
    && id.head_sha === record.source.sha && id.repository_id === record.repository.id
    && id.head_repository_id === record.repository.id,
  "handoff decision identity is not the publisher preflight's decision for the source commit");
  refuse(typeof d.preflight === "string" && SHA256.test(d.preflight), "handoff decision preflight execution is not a sha256");
  refuse(ISO.test(d.decidedAt ?? "") && DECISION_MODES.includes(d.mode), "handoff decision time or mode is malformed");
  if (sb.coverage.mode === COVERAGE_CERTIFIED) {
    const w = sb.coverage.witness;
    refuse(w.attempt === sb.originalAttempt && w.target.run_id === sb.runId && w.target.sha === record.source.sha
      && w.target.repository_id === record.repository.id,
    "handoff certified coverage is not of the signed build's own run, commit and original attempt");
  }
}

/**
 * The earliest instant any artifact `verify` must re-read expires: the
 * notarized artifact, and for a reuse its decision and every certified-chain
 * artifact (witness, proof, source certificates). Until then the record is
 * mechanically verifiable; after it `verify` refuses and nothing here can
 * vouch for the chain again.
 */
export function verifiableUntil(record) {
  const times = [record.artifact.expiresAt];
  const sb = record.signedBuild;
  if (sb?.decision) times.push(sb.decision.identity.expires_at);
  if (sb?.coverage?.mode === COVERAGE_CERTIFIED) {
    times.push(sb.coverage.witness.identity.expires_at, sb.coverage.source.proofIdentity.expires_at);
    for (const cert of Object.values(sb.coverage.certificates)) for (const a of cert.artifacts) times.push(a.expires_at);
  }
  return times.reduce((min, t) => (Date.parse(t) < Date.parse(min) ? t : min));
}

/**
 * Refuse unless the record's earliest retained-chain expiry is strictly after
 * the machine time `at`. Exact comparison, no headroom: a historical verify
 * is not a new selection.
 */
function expiryAtEnd(record, at, when) {
  const until = verifiableUntil(record);
  refuse(Number.isFinite(at) && Date.parse(until) > at,
    `the retained chain expired at ${until} before ${when} (machine clock ${Number.isFinite(at) ? new Date(at).toISOString() : at})`);
}

/** The release notes the workflow mode passes to `gh release create`. */
export function releaseNotes(runId) {
  return "Signed, notarized macOS release for Apple Silicon Macs. The disk image passed Apple notarization, "
    + `stapling, and Gatekeeper assessment in workflow run ${runId}.`;
}


// ── git adapter ─────────────────────────────────────────────────────────────

function git(args, cwd, input) {
  const out = spawnSync("git", args, { cwd, input, encoding: "buffer", maxBuffer: 256 * 1024 * 1024 });
  refuse(out.status === 0, `git ${args.join(" ")} failed`);
  return out.stdout;
}

/**
 * The raw commit header — tree and parents — up to the first blank line, read
 * from the object itself rather than through `%P`, which a shallow clone
 * silently empties.
 */
function commitHeader(commit, cwd) {
  const header = git(["cat-file", "commit", commit], cwd).toString("utf8").split("\n\n")[0].split("\n");
  const trees = header.filter((l) => l.startsWith("tree ")).map((l) => l.slice(5));
  refuse(trees.length === 1 && SHA40.test(trees[0]), `commit ${commit} has no single tree line`);
  const parents = header.filter((l) => l.startsWith("parent ")).map((l) => l.slice(7));
  return { tree: trees[0], parents };
}

/**
 * The local commit object must be the one the server holds: same tree, same
 * parents. A verifier that read only local objects would judge whatever the
 * operator's checkout happened to contain.
 */
async function authenticCommit(api, repo, commit, cwd) {
  refuse(SHA40.test(commit ?? ""), `${JSON.stringify(commit)} is not a commit SHA`);
  const local = commitHeader(commit, cwd);
  const remote = await api.get(`/repos/${repo}/git/commits/${commit}`);
  const remoteParents = (remote?.parents ?? []).map((p) => p?.sha);
  refuse(remote?.sha === commit && remote?.tree?.sha === local.tree
    && JSON.stringify(remoteParents) === JSON.stringify(local.parents),
  `the local commit ${commit} is not the server's (tree/parents differ)`);
  return local;
}

const isAncestor = (a, b, cwd) => spawnSync("git", ["merge-base", "--is-ancestor", a, b], { cwd }).status === 0;

/**
 * The base-owned judges: the scope checker, the lane selector, the web lane's
 * scope module, the CI evidence registry (the exact, matrix-expanded job names
 * every lane reports) and the workflow files themselves, exactly as the BASE
 * commit carries them, copied out of the Git object database into a fresh
 * private directory and imported from there. Neither the candidate nor the
 * invoking checkout can author the rules — or the job roster — its own
 * candidate is judged by. A base that does not carry a loadable judge is
 * refused, not replaced by a local one.
 */
export const BASE_JUDGE_PATHS = Object.freeze([
  "web/scripts/macos-release-candidate.mjs",
  "scripts/ci/select-lanes.mjs",
  "scripts/ci/web-lane-scope.mjs",
  "scripts/ci/ci-evidence-registry.json",
  ".github/workflows",
]);
const BASE_JUDGE_FILES = BASE_JUDGE_PATHS.slice(0, 4);
const REGISTRY_SCHEMA = "relayium.ci-evidence.registry/v1";

export async function loadBaseJudges(base, cwd) {
  for (const path of BASE_JUDGE_FILES) {
    const type = spawnSync("git", ["cat-file", "-t", `${base}:${path}`], { cwd, encoding: "utf8" });
    refuse(type.status === 0 && type.stdout.trim() === "blob", `the base ${base} carries no ${path}; its judge is unknown`);
  }
  const dir = mkdtempSync(join(tmpdir(), "macos-handoff-base-"));
  try {
    const tar = git(["archive", "--format=tar", base, "--", ...BASE_JUDGE_PATHS], cwd);
    const out = spawnSync("tar", ["-x", "-f", "-", "-C", dir], { input: tar });
    refuse(out.status === 0, "the base judges could not be unpacked");
    for (const path of BASE_JUDGE_FILES) {
      const blob = git(["rev-parse", `${base}:${path}`], cwd).toString().trim();
      const bytes = readFileSync(join(dir, path));
      refuse(git(["hash-object", "--stdin"], cwd, bytes).toString().trim() === blob,
        `the unpacked ${path} is not the base's blob`);
    }
    const scope = await import(pathToFileURL(join(dir, "web/scripts/macos-release-candidate.mjs")).href);
    const lanes = await import(pathToFileURL(join(dir, "scripts/ci/select-lanes.mjs")).href);
    const webScope = await import(pathToFileURL(join(dir, "scripts/ci/web-lane-scope.mjs")).href);
    refuse(typeof scope.checkCandidateScope === "function", "the base scope checker exports no checkCandidateScope");
    refuse(typeof lanes.selectLanes === "function" && Array.isArray(lanes.LANES) && Array.isArray(lanes.CONTROL_FILES),
      "the base lane selector is not the known selectLanes/LANES/CONTROL_FILES module");
    let registry;
    try {
      registry = JSON.parse(readFileSync(join(dir, "scripts/ci/ci-evidence-registry.json"), "utf8"));
    } catch (error) {
      throw new Refused(`the base CI evidence registry is not JSON: ${error.message}`);
    }
    refuse(registry?.schema === REGISTRY_SCHEMA && registry.lanes && typeof registry.lanes === "object",
      `the base CI evidence registry is not ${REGISTRY_SCHEMA}`);
    const workflowsDir = join(dir, ".github/workflows");
    const readWorkflow = (file) => {
      refuse(/^[a-z0-9-]+\.yml$/.test(file), `${JSON.stringify(file)} is not a workflow file name`);
      try {
        return readFileSync(join(workflowsDir, file), "utf8");
      } catch {
        throw new Refused(`the base carries no .github/workflows/${file}`);
      }
    };
    return {
      checkScope: (paths) => scope.checkCandidateScope(paths, { alreadyDelivered: false }),
      // The frozen selector's rule: a control file selects every lane.
      // `SelectAll` is the selector's own "run everything" answer.
      expectedLanes: (paths) => {
        const all = new Set(lanes.LANES.map((l) => l.id));
        if (paths.some((p) => lanes.CONTROL_FILES.includes(p))) return all;
        try {
          return lanes.selectLanes(paths, { workflowsDir });
        } catch (error) {
          if (typeof lanes.SelectAll === "function" && error instanceof lanes.SelectAll) return all;
          throw error;
        }
      },
      allLanes: () => new Set(lanes.LANES.map((l) => l.id)),
      laneIds: lanes.LANES.map((l) => l.id),
      registry,
      readWorkflow,
      webScopeForDispatch: () => webScopeForDispatch(webScope),
      cleanup: () => rmSync(dir, { recursive: true, force: true }),
    };
  } catch (error) {
    rmSync(dir, { recursive: true, force: true });
    throw error;
  }
}

/**
 * The web lane's `light` output in a dispatched gate, as BASE's own scope
 * module computes it: it does not diff a `workflow_dispatch` event and answers
 * "run everything". A base whose module answers otherwise (or differently than
 * this file understands) leaves the gated jobs' obligation unknown: refused.
 */
function webScopeForDispatch(webScope) {
  refuse(typeof webScope.changedPaths === "function" && typeof webScope.ScopeAll === "function",
    "the base web-lane scope module is not the known changedPaths/ScopeAll module");
  try {
    webScope.changedPaths({ WEB_SCOPE_EVENT: "workflow_dispatch" }, () => {
      throw new Refused("the base web-lane scope module tried to read Git for a dispatched gate");
    });
  } catch (error) {
    if (error instanceof webScope.ScopeAll) return true;
    throw error instanceof Refused ? error : new Refused(`the base web-lane scope failed: ${error.message}`);
  }
  throw new Refused("the base web-lane scope module diffs a dispatched gate; the gated web jobs' obligation is unknown");
}

/**
 * The `jobs:` block of a workflow file at two-space job indentation: each
 * job's id and its single-line `if:`, `name:` and `uses:`, and whether it has a
 * `strategy:`. Deliberately narrow — the shapes this repository's workflows
 * use — and refusing anything else (a block scalar, an unreadable job line, a
 * repeated id) rather than guessing.
 */
export function workflowJobs(text, file) {
  const lines = text.split("\n");
  const start = lines.indexOf("jobs:");
  refuse(start >= 0, `${file} has no top-level jobs: block`);
  const jobs = new Map();
  let current = null;
  for (const line of lines.slice(start + 1)) {
    if (line.trim() === "" || /^\s*#/.test(line)) continue;
    if (/^\S/.test(line)) break;
    const id = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(line);
    if (id) {
      refuse(!jobs.has(id[1]), `${file} defines job ${id[1]} twice`);
      current = { id: id[1], if: undefined, name: undefined, uses: undefined, strategy: false };
      jobs.set(id[1], current);
      continue;
    }
    refuse(/^ {4}/.test(line) && current !== null, `${file} has an unreadable job line ${JSON.stringify(line.slice(0, 80))}`);
    const key = /^ {4}(if|name|uses|strategy):(.*)$/.exec(line);
    if (!key) continue;
    const value = key[2].trim();
    if (key[1] === "strategy") {
      current.strategy = true;
      continue;
    }
    refuse(value !== "" && !/^[|>]/.test(value), `${file} job ${current.id} has a multi-line ${key[1]}`);
    current[key[1]] = value;
  }
  refuse(jobs.size > 0, `${file} defines no jobs`);
  return jobs;
}

/**
 * Every job predicate the lane workflows use, and what it means in a
 * `workflow_dispatch` merge gate (the frozen release-metadata and internal
 * full-candidate modes). `run` — the job must have run and succeeded (the
 * `needs` it names are themselves required jobs of the lane, so they
 * succeeded too); `main-only` — it runs only on a push to main and is a
 * planned skip here; `web-light` — gated on the web scope's `light` output.
 * A predicate not in this table is unknown and refused: a gate this file
 * cannot predict is not a gate it can vouch for.
 */
export const DISPATCH_PREDICATES = Object.freeze({
  "${{ !cancelled() }}": "run",
  "${{ !cancelled() && github.event_name == 'push' && github.ref == 'refs/heads/main' }}": "main-only",
  "${{ !cancelled() && github.event_name == 'push' && github.ref == 'refs/heads/main' && needs.screen.result == 'success' && needs.screen.outputs.eligible == 'true' }}": "main-only",
  "${{ !cancelled() && needs.scope.result == 'success' && (needs.scope.outputs.light != 'false') }}": "web-light",
  "${{ !cancelled() && needs.contract.result == 'success' && (github.event_name != 'pull_request' || github.event.pull_request.head.repo.full_name == github.repository) }}": "run",
  "${{ !cancelled() && needs.test.result == 'success' && needs.contract.result == 'success' && (github.event_name != 'pull_request' || github.event.pull_request.head.repo.full_name == github.repository) }}": "run",
});

/** Auxiliary jobs whose own outcome decides nothing; a skip is never a gap. */
const AUXILIARY_LANE_JOBS = new Set(["evidence", "screen", "certify-macos", "certify-windows"]);

/**
 * The complete job roster a `workflow_dispatch` merge-gate run of BASE must
 * report, derived only from BASE: its `merge-gate.yml` callers, each called
 * workflow's jobs and predicates, and the evidence registry's exact check
 * names for matrix and templated jobs. Returns name → allowed conclusions and
 * whether the job must be present.
 */
export function dispatchGateRoster(judges, expected) {
  const roster = new Map();
  const add = (name, conclusions, required) => {
    refuse(!roster.has(name), `the base roster names ${JSON.stringify(name)} twice`);
    roster.set(name, { conclusions, required });
  };
  const gate = workflowJobs(judges.readWorkflow("merge-gate.yml"), "merge-gate.yml");
  const callers = [];
  for (const job of gate.values()) {
    if (job.uses === undefined) {
      refuse(job.id === "select" || (job.id === "merge-gate" && job.if === "always()"),
        `merge-gate.yml job ${job.id} is neither a lane, the selector nor the aggregate`);
      add(job.id, ["success"], true);
      continue;
    }
    const file = /^\.\/\.github\/workflows\/([a-z0-9-]+\.yml)$/.exec(job.uses);
    refuse(file !== null, `merge-gate.yml lane ${job.id} calls ${JSON.stringify(job.uses)}, not a local workflow`);
    let conditional;
    if (job.if === undefined) conditional = false;
    else {
      refuse(job.if === `needs.select.outputs['${job.id}'] == 'true'` && judges.laneIds.includes(job.id),
        `merge-gate.yml lane ${job.id} has an unknown predicate ${JSON.stringify(job.if)}`);
      conditional = true;
    }
    callers.push({ id: job.id, file: file[1], conditional });
  }
  refuse(roster.has("select") && roster.has("merge-gate"), "merge-gate.yml has no selector or aggregate job");
  for (const id of judges.laneIds) {
    refuse(callers.some((c) => c.id === id && c.conditional), `merge-gate.yml does not call the selector's lane ${id}`);
  }
  for (const id of expected) refuse(judges.laneIds.includes(id), `the selection names an unknown lane ${id}`);
  let light;
  for (const caller of callers) {
    if (caller.conditional && !expected.has(caller.id)) {
      add(caller.id, ["skipped"], true);
      continue;
    }
    const registered = judges.registry.lanes[caller.id];
    refuse(registered === undefined || registered.workflow === caller.file,
      `the registry's lane ${caller.id} names ${registered?.workflow}, merge-gate.yml calls ${caller.file}`);
    const jobs = workflowJobs(judges.readWorkflow(caller.file), caller.file);
    for (const jobId of Object.keys(registered?.jobs ?? {})) {
      refuse(jobs.has(jobId), `the registry names ${caller.id}/${jobId}, which ${caller.file} does not define`);
    }
    for (const job of jobs.values()) {
      const kind = job.if === undefined ? "run" : DISPATCH_PREDICATES[job.if];
      refuse(kind !== undefined, `${caller.file} job ${job.id} has an unknown predicate ${JSON.stringify(job.if)}`);
      refuse(job.uses === undefined, `${caller.file} job ${job.id} calls another workflow; its jobs are unknown`);
      let names;
      const checks = registered?.jobs?.[job.id]?.checks;
      if (job.strategy || String(job.name ?? "").includes("${{")) {
        refuse(Array.isArray(checks) && checks.length > 0 && checks.every((c) => typeof c === "string" && c !== ""),
          `${caller.file} job ${job.id} expands to names only the evidence registry knows, and it names none`);
        names = checks;
      } else {
        names = [job.name ?? job.id];
        refuse(checks === undefined || JSON.stringify(checks) === JSON.stringify(names),
          `the registry names ${caller.id}/${job.id} ${JSON.stringify(checks)}, ${caller.file} reports ${JSON.stringify(names)}`);
        refuse(checks !== undefined || registered === undefined || AUXILIARY_LANE_JOBS.has(job.id),
          `${caller.file} job ${job.id} is not in the evidence registry's ${caller.id} lane`);
      }
      let runs = kind === "run";
      if (kind === "web-light") {
        refuse(registered?.scope?.gates?.includes(job.id) && jobs.has(registered.scope.job),
          `${caller.file} job ${job.id} is gated on a scope the registry does not declare`);
        if (light === undefined) light = judges.webScopeForDispatch();
        runs = light;
      }
      for (const name of names) {
        const full = `${caller.id} / ${name}`;
        if (AUXILIARY_LANE_JOBS.has(job.id)) add(full, runs ? ["success", "skipped"] : ["skipped"], runs);
        else if (runs) add(full, ["success"], true);
        else add(full, ["skipped"], false);
      }
    }
  }
  return roster;
}

/**
 * The gate run's actual job graph against the BASE-derived roster: every
 * required job present exactly once, at an attempt of this run, with an
 * allowed conclusion (`success` for every required lane job); planned skips
 * (main-only auxiliaries, unselected lanes) skipped; no job the roster does not
 * name; no name twice. `judgeGateRun` has already proven the latest attempt,
 * completion and no red job.
 */
export async function judgeGateLanes(api, { repository, runId, attempt, head, expected, judges }) {
  const roster = dispatchGateRoster(judges, expected);
  const jobs = await paginate(api, `/repos/${repository}/actions/runs/${runId}/attempts/${attempt}/jobs`, "jobs");
  const seen = new Set();
  for (const job of jobs) {
    const name = String(job?.name ?? "");
    const want = roster.get(name);
    refuse(want !== undefined, `merge-gate run ${runId} has a job ${JSON.stringify(name)} outside the base-owned roster`);
    refuse(!seen.has(name), `merge-gate run ${runId} lists ${JSON.stringify(name)} more than once`);
    seen.add(name);
    refuse(job.run_id === runId && job.head_sha === head && job.status === "completed"
      && Number.isSafeInteger(job.run_attempt) && job.run_attempt >= 1 && job.run_attempt <= attempt,
    `merge-gate run ${runId} job ${JSON.stringify(name)} is not a completed job of this run at attempt <= ${attempt}`);
    refuse(want.conclusions.includes(job.conclusion),
      `merge-gate run ${runId} job ${JSON.stringify(name)} concluded ${job.conclusion}; the base roster requires ${want.conclusions.join(" or ")}`);
  }
  const missing = [...roster].filter(([name, want]) => want.required && !seen.has(name)).map(([name]) => name);
  refuse(missing.length === 0, `merge-gate run ${runId} lacks required job(s) ${missing.join(", ")}`);
  return { jobs: jobs.length, required: [...roster.values()].filter((w) => w.required).length };
}

// ── the notarized artifact ──────────────────────────────────────────────────

/** Exactly what `notarize-stage` uploads, relative to its common root. */
export const RELEASE_PAYLOAD = Object.freeze([
  "Relayium.dmg",
  "Relayium.dmg.sha256",
  "provenance.json",
  ...Object.values(ARTIFACT_PATHS),
]);
const PAYLOAD_DIRS = new Set(["release-web/", "release-web/public/", "release-web/public/apps/",
  "release-web/public/apps/macos/", "server/", "server/account/"]);

/**
 * The release artifact's eight files, in memory, from a ZIP whose bytes were
 * already proven to hash to the API digest. Strict exactly as the reuse
 * payload is: safe names, no duplicate, regular files only, canonical parent
 * directories only and empty, nothing missing and nothing extra.
 */
export function readReleaseArchive(zip) {
  const files = new Map();
  for (const entry of readZipEntries(zip)) {
    const unsafe = unsafeNameReason(entry.raw);
    refuse(unsafe === null, `the release artifact names ${JSON.stringify(entry.name)}, which contains ${unsafe}`);
    refuse(!files.has(entry.name), `the release artifact names ${entry.name} twice`);
    const kind = entryKind(entry);
    if (entry.name.endsWith("/")) {
      refuse(PAYLOAD_DIRS.has(entry.name) && kind === "directory" && entry.data.length === 0,
        `the release artifact holds an unexpected directory ${entry.name}`);
      files.set(entry.name, null);
      continue;
    }
    refuse(kind === "file", `the release artifact's ${entry.name} is a ${kind}, not a regular file`);
    refuse(RELEASE_PAYLOAD.includes(entry.name), `the release artifact holds unexpected ${entry.name}`);
    files.set(entry.name, entry.data);
  }
  const missing = RELEASE_PAYLOAD.filter((f) => !files.get(f));
  refuse(missing.length === 0, `the release artifact lacks ${missing.join(", ")}`);
  for (const dir of PAYLOAD_DIRS) files.delete(dir);
  return files;
}

/** A regular, single-link local file read through O_NOFOLLOW, never a link. */
function readRegular(path) {
  let stat;
  try {
    stat = lstatSync(path);
  } catch {
    throw new Refused(`${path} does not exist`);
  }
  refuse(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1, `${path} is not a regular single-link file`);
  const fd = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const f = fstatSync(fd);
    refuse(f.ino === stat.ino && f.dev === stat.dev, `${path} changed identity while it was opened`);
    return readFileSync(fd);
  } finally {
    closeSync(fd);
  }
}

/**
 * The artifact archive, from the API by its id — or, when the operator passes
 * one, from that file — and in both cases only once its bytes hash to the
 * digest the API reports for that id. The record never authenticates the
 * archive; the API digest does.
 */
async function fetchArchive(api, repo, artifact, archivePath) {
  let zip;
  if (archivePath) {
    zip = readRegular(archivePath);
  } else {
    try {
      zip = await api.download(`/repos/${repo}/actions/artifacts/${artifact.id}/zip`);
    } catch (error) {
      throw new Refused(`artifact ${artifact.id} could not be downloaded (HTTP ${error?.status ?? "?"})`);
    }
  }
  refuse(Buffer.isBuffer(zip), `artifact ${artifact.id} download returned no bytes`);
  refuse(`sha256:${sha256(zip)}` === artifact.digest,
    `artifact ${artifact.id} archive hashes to sha256:${sha256(zip)}, not the API digest ${artifact.digest}`);
  return readReleaseArchive(zip);
}

const PROVENANCE_KEYS = ["schema", "repository", "repositoryId", "sha", "ref", "event", "runId", "runAttempt",
  "workflowRef", "workflowSha", "releaseVersion", "channel", "arch", "teamId", "version", "build",
  "shareExtensionVersion", "shareExtensionBuild", "toolchain", "signedBuildSource", "signedDmgSha256", "dmgSha256",
  "generateAppcastSha256", "notarized", "notarizedBy"].sort();

/**
 * The notarized provenance from the verified archive, as `macos.yml` writes it
 * and `notarize-stage` finalizes it: the v2 producer record with exact keys,
 * plus `notarized` and `notarizedBy`. Every field that the publisher run proves
 * is compared to it; the DMG and checksum are the archive's own bytes.
 */
export function judgeReleaseProvenance(files, expect) {
  let p;
  try {
    p = JSON.parse(files.get("provenance.json").toString("utf8"));
  } catch (error) {
    throw new Refused(`the artifact's provenance.json is not JSON: ${error.message}`);
  }
  refuse(p !== null && typeof p === "object" && !Array.isArray(p), "the artifact's provenance is not an object");
  refuse(JSON.stringify(Object.keys(p).sort()) === JSON.stringify(PROVENANCE_KEYS),
    `the artifact's provenance has keys [${Object.keys(p).sort().join(", ")}]; want exactly [${PROVENANCE_KEYS.join(", ")}]`);
  const exact = (key, want) => refuse(p[key] === want,
    `provenance.${key} is ${JSON.stringify(p[key])}, want ${JSON.stringify(want)}`);
  const dmg = files.get("Relayium.dmg");
  const dmgSha = sha256(dmg);
  exact("schema", PROVENANCE_SCHEMA);
  exact("repository", expect.repository);
  exact("repositoryId", String(expect.repositoryId));
  exact("sha", expect.sha);
  exact("ref", "refs/heads/main");
  exact("channel", "direct");
  exact("arch", "arm64");
  exact("teamId", TEAM_ID);
  exact("signedBuildSource", "built");
  exact("notarized", true);
  exact("dmgSha256", dmgSha);
  exact("workflowSha", expect.sha);
  refuse(SHA256.test(p.signedDmgSha256 ?? "") && SHA256.test(p.generateAppcastSha256 ?? ""),
    "the artifact's provenance carries malformed signed-DMG or tool hashes");
  refuse(VERSION.test(p.version ?? "") && /^[1-9][0-9]{0,8}$/.test(p.build ?? ""),
    "the artifact's provenance carries no version/build");
  exact("shareExtensionVersion", p.version);
  exact("shareExtensionBuild", p.build);
  const tc = p.toolchain;
  refuse(tc && typeof tc === "object" && JSON.stringify(Object.keys(tc).sort()) === '["macos","runnerImage","swift","xcode"]'
    && Object.values(tc).every((v) => typeof v === "string" && v !== ""), "the artifact's provenance toolchain is malformed");
  const nb = p.notarizedBy;
  refuse(nb && typeof nb === "object" && JSON.stringify(Object.keys(nb).sort()) === '["runAttempt","runId","signedBuildSource"]',
    "provenance.notarizedBy is malformed");
  refuse(nb.runId === String(expect.runId) && nb.runAttempt === String(expect.notarizeAttempt),
    `provenance.notarizedBy names run ${nb.runId} attempt ${nb.runAttempt}, not ${expect.runId} attempt ${expect.notarizeAttempt}`);
  refuse(["build", "reuse"].includes(nb.signedBuildSource), `provenance.notarizedBy.signedBuildSource is ${JSON.stringify(nb.signedBuildSource)}`);
  if (nb.signedBuildSource === "build") {
    // Built by this release run through the reusable call: the caller's
    // identity is what a called workflow reports.
    exact("runId", String(expect.runId));
    exact("event", "workflow_dispatch");
    exact("workflowRef", `${expect.repository}/.github/workflows/macos-release.yml@refs/heads/main`);
    exact("releaseVersion", p.version);
  } else {
    exact("event", "push");
    exact("workflowRef", `${expect.repository}/.github/workflows/macos.yml@refs/heads/main`);
    exact("releaseVersion", "");
    refuse(/^[1-9][0-9]*$/.test(p.runId ?? ""), "provenance.runId is not a run id");
  }
  refuse(/^[1-9][0-9]*$/.test(p.runAttempt ?? ""), "provenance.runAttempt is not an attempt");
  refuse(files.get("Relayium.dmg.sha256").toString("utf8") === `${dmgSha}  Relayium.dmg\n`,
    "the artifact's Relayium.dmg.sha256 is not exactly the DMG's checksum line");
  return p;
}

const runPath = (run) => String(run?.path ?? "").replace(/@.*$/, "");
const GATE_WORKFLOW_PATH = ".github/workflows/merge-gate.yml";

/**
 * The publisher run and the artifact, as records. The artifact must be this
 * run's, carry exactly its name, and have been created while this attempt's
 * `notarize-stage` job ran — the job that uploads it — and that job must have
 * succeeded. `terminal` (verify) additionally requires the run and its publish
 * job to have completed successfully; emit runs inside the still-live publish
 * job and requires it in progress instead.
 */
async function judgePublisher(api, { repo, repoId, sha, runId, attempt, artifactId, name, terminal }) {
  const run = await api.get(`/repos/${repo}/actions/runs/${runId}`);
  refuse(run?.id === runId && run?.head_sha === sha && runPath(run) === ".github/workflows/macos-release.yml"
    && run?.event === "workflow_dispatch" && run?.head_branch === "main"
    && run?.repository?.id === repoId && run?.head_repository?.id === repoId && run?.repository?.fork === false,
  `publisher run ${runId} is not macos-release.yml dispatched on main at ${sha} in repository ${repoId}`);
  refuse(run.run_attempt === attempt, `publisher run is now attempt ${run.run_attempt}, not ${attempt}`);
  if (terminal) {
    refuse(run.status === "completed" && run.conclusion === "success",
      `publisher run ${runId} is ${run.status}/${run.conclusion}; the handoff exists only after it succeeded`);
  }
  const jobs = await paginate(api, `/repos/${repo}/actions/runs/${runId}/attempts/${attempt}/jobs`, "jobs");
  const one = (jobName) => {
    const hits = jobs.filter((j) => j?.name === jobName);
    refuse(hits.length === 1 && hits[0].run_id === runId && hits[0].head_sha === sha,
      `publisher run ${runId} attempt ${attempt} has ${hits.length} \`${jobName}\` job(s)`);
    return hits[0];
  };
  const notarize = one("notarize-stage");
  refuse(notarize.status === "completed" && notarize.conclusion === "success"
    && Number.isSafeInteger(notarize.run_attempt) && notarize.run_attempt >= 1 && notarize.run_attempt <= attempt,
  `publisher notarize-stage is ${notarize.status}/${notarize.conclusion}`);
  // Its label is NOT the provenance attempt: a carried notarize-stage may be
  // relabelled with this attempt's number. `judgeNotaryOrigin` proves the
  // execution from the provenance's own attempt after the archive is verified.
  const publish = one("publish");
  refuse(terminal ? publish.status === "completed" && publish.conclusion === "success" : publish.status === "in_progress",
    `publisher publish job is ${publish.status}/${publish.conclusion}`);

  const listed = await paginate(api, `/repos/${repo}/actions/runs/${runId}/artifacts`, "artifacts");
  const named = listed.filter((a) => a?.name === name);
  refuse(named.length === 1, `publisher run ${runId} carries ${named.length} artifacts named ${name}`);
  refuse(artifactId === undefined || named[0].id === artifactId, `the artifact named ${name} is ${named[0].id}, not ${artifactId}`);
  const art = await api.get(`/repos/${repo}/actions/artifacts/${named[0].id}`);
  refuse(art?.id === named[0].id && art?.name === name, `artifact ${named[0].id} is not ${name}`);
  refuse(art.workflow_run?.id === runId && art.workflow_run?.head_sha === sha
    && art.workflow_run?.repository_id === repoId && art.workflow_run?.head_repository_id === repoId,
  `artifact ${art.id} does not belong to publisher run ${runId} at ${sha}`);
  refuse(/^sha256:[0-9a-f]{64}$/.test(String(art.digest ?? "")), `artifact ${art.id} has no sha256 digest`);
  return { run, art, notarize, jobs };
}

/**
 * The notarization that produced the artifact. The attempt is read from the
 * DIGEST-VERIFIED archive's provenance (`notarizedBy.runAttempt`) — never
 * from the latest inventory's label — and then proved: that attempt of this
 * run ran exactly one successful notarize-stage, the latest attempt's
 * notarize-stage is that same execution (`judgeExecutionOrigin`: times,
 * labels, steps; a relabelled wrapper is accepted, a re-execution is not),
 * and the artifact was created inside that ORIGINAL execution's window. The
 * whole original attempt may have failed later (its publish job did, on run
 * 36943045523); the latest run's status rules are `judgePublisher`'s.
 */
async function judgeNotaryOrigin(api, { repo, repoId, sha, runId, attempt, art, notarize, files }) {
  let claimed = NaN;
  try {
    const nb = JSON.parse(files.get("provenance.json").toString("utf8"))?.notarizedBy;
    if (nb?.runId === String(runId) && /^[1-9][0-9]*$/.test(nb?.runAttempt ?? "")) claimed = Number(nb.runAttempt);
  } catch {
    // judgeReleaseProvenance below names the malformation.
  }
  if (!Number.isFinite(claimed)) judgeReleaseProvenance(files, { repository: repo, repositoryId: repoId, sha, runId, notarizeAttempt: "?" });
  const origin = await judgeExecutionOrigin(api, {
    repository: repo, runId, sha, workflowPath: ".github/workflows/macos-release.yml", jobName: "notarize-stage",
    originalAttempt: claimed, latestAttempt: attempt, latestJob: notarize,
  });
  const created = Date.parse(art.created_at);
  refuse(Number.isFinite(created) && created >= Date.parse(origin.job.started_at) && created <= Date.parse(origin.job.completed_at),
    `artifact ${art.id} was created at ${art.created_at}, outside notarize-stage ${origin.job.started_at}..${origin.job.completed_at} (attempt ${origin.attempt})`);
  const provenance = judgeReleaseProvenance(files, { repository: repo, repositoryId: repoId, sha, runId, notarizeAttempt: origin.attempt });
  return { provenance, origin };
}

/**
 * Where the signed DMG came from. A fresh build is this run's own `build`
 * reusable call; a reuse names a push run of `macos.yml` on main at the same
 * commit that completed successfully.
 */
async function judgeBuildSource(api, { repo, repoId, sha, runId, attempt, provenance, jobs }) {
  if (provenance.notarizedBy.signedBuildSource === "build") {
    // The called `macos.yml` at the immutable source, judged WHOLE: its shape,
    // the complete `build / ` roster and every gate job's executed steps.
    const built = jobs.filter((j) => String(j?.name ?? "").startsWith("build / "));
    const proof = await judgeImmutableProducer(api, {
      repo, sha, jobs: built, runId, latestAttempt: attempt, prefix: "build / ", called: true,
      what: `publisher run ${runId}'s own build`,
    });
    // Proved from the provenance's attempt, not the latest label (see judgeNotaryOrigin).
    const origin = await judgeExecutionOrigin(api, {
      repository: repo, runId, sha, workflowPath: ".github/workflows/macos-release.yml", jobName: "build / signed-build",
      originalAttempt: /^[1-9][0-9]*$/.test(provenance.runAttempt) ? Number(provenance.runAttempt) : NaN,
      latestAttempt: attempt, latestJob: proof.signed,
    });
    return { runId, attempt, origin: origin.identity, shape: proof.shape, built: true };
  }
  const pre = jobs.filter((j) => j?.name === "preflight");
  refuse(pre.length === 1 && pre[0].conclusion === "success", "the publisher preflight that chose reuse did not succeed");
  return judgeProducer(api, { repo, repoId, sha, provenance });
}

/**
 * The reused producer: a successful `macos.yml` push run on main at the source,
 * judged at its LATEST attempt — the attempt record and that attempt's complete
 * job inventory — with the provenance's `runAttempt` proved as the ORIGINAL
 * execution of the latest attempt's `signed-build` (`judgeExecutionOrigin`).
 * The latest label is not that attempt: GitHub may relabel a carried job with
 * the new attempt and a new id, so a signed-build carried from attempt 1 into
 * attempt 4 is legitimate under either label; a signed-build that ran again
 * (other times or steps) is not the build this provenance describes.
 *
 * `selectProducerRun` is not reused: its freshness bound (a week after the
 * run, against the current clock) and its current-workflow-state checks decide
 * whether a NEW release may reuse a build, and would refuse an old but
 * authentic handoff at verify time. The inventory rule here is the same one it
 * applies (exact expected jobs, each once, the adoption auxiliaries all or
 * none), from the same exported matchers.
 */
async function judgeProducer(api, { repo, repoId, sha, provenance }) {
  const runId = Number(provenance.runId);
  const producer = await api.get(`/repos/${repo}/actions/runs/${runId}`);
  refuse(producer?.id === runId && producer?.head_sha === sha && producer?.event === "push"
    && producer?.head_branch === "main" && runPath(producer) === ".github/workflows/macos.yml"
    && producer?.repository?.id === repoId && producer?.head_repository?.id === repoId
    && producer?.status === "completed" && producer?.conclusion === "success"
    && Number.isSafeInteger(producer?.run_attempt) && producer.run_attempt >= 1,
  `the reused producer run ${provenance.runId} is not a successful macos.yml push run on main at ${sha}`);
  const latest = producer.run_attempt;
  const record = await api.get(`/repos/${repo}/actions/runs/${runId}/attempts/${latest}`);
  refuse(record?.id === runId && record?.run_attempt === latest && record?.head_sha === sha
    && record?.status === "completed" && record?.conclusion === "success",
  `attempt ${latest} of the reused producer run ${runId} is not a successful attempt of that run`);
  const jobs = await paginate(api, `/repos/${repo}/actions/runs/${runId}/attempts/${latest}/jobs`, "jobs");
  const proof = await judgeImmutableProducer(api, {
    repo, sha, jobs, runId, latestAttempt: latest, prefix: "", called: false, what: `the reused producer run ${runId}`,
  });
  const signed = proof.signed;
  const origin = await judgeExecutionOrigin(api, {
    repository: repo, runId, sha, workflowPath: ".github/workflows/macos.yml", jobName: "signed-build",
    originalAttempt: /^[1-9][0-9]*$/.test(provenance.runAttempt) ? Number(provenance.runAttempt) : NaN,
    latestAttempt: latest, latestJob: signed,
  });
  return { runId, attempt: latest, status: producer.status, conclusion: producer.conclusion, origin: origin.identity,
    shape: proof.shape };
}

/**
 * The signed producer's execution proof at the IMMUTABLE source commit, for
 * both a reused push run and the publisher's own `build / ` call: `macos.yml`
 * read at `sha` (`readProducerShape`), the complete roster of one attempt and
 * each gate job's executed steps and runner (`judgeProducerRoster`, which
 * applies `judgeExecution`). The SAME helpers reuse selection uses — but none
 * of its freshness or current-workflow-state rules, which decide whether a NEW
 * release may reuse a build and would refuse an old, authentic handoff. Every
 * reason the proof fails is a refusal here: verify has no rebuild to fall back
 * to.
 */
async function judgeImmutableProducer(api, { repo, sha, jobs, runId, latestAttempt, prefix, called, what }) {
  let shape;
  let roster;
  try {
    ({ shape } = await readProducerShape(api, { repository: repo, sha }));
    roster = judgeProducerRoster(jobs, { runId, sha, latestAttempt, shape, prefix, called });
  } catch (error) {
    if (error instanceof Refused) throw new Refused(`${what}: ${error.message}`);
    if (error instanceof Unavailable) throw new Refused(`${what} is not a proved signed build: ${error.message}`);
    throw new Refused(`${what}: ${PRODUCER_PATH} at ${sha} could not be read (${error?.status ?? error?.message ?? "?"})`);
  }
  return { shape, signed: roster.jobs[EXPECTED_JOBS.findIndex((e) => e.id === "signed-build")] };
}

// ── the v2 signed-build chain ───────────────────────────────────────────────

/** API timestamps are whole seconds: the tolerance on either side of a step window. */
const STEP_SKEW_MS = 2_000;
const DECISION_ENTRY = "reuse-decision.json";
const DECISION_BYTES = 256 * 1024;
const SELECT_STEP = "Select the signed-build source";
const UPLOAD_STEP = "Upload the signed-build source decision";
const DECISION_RECORD_KEYS = ["decidedAt", "evidence", "mode", "reason", "source"];
const EVIDENCE_KEYS = ["artifact", "build", "coverage", "files", "jobs", "repository", "repositoryId", "run", "schema", "sha",
  "signedBuildOrigin", "toolchain", "version", "workflow"];
const sorted = (o) => JSON.stringify(Object.keys(o ?? {}).sort());
const canonical = (v) => (Array.isArray(v) ? v.map(canonical)
  : v !== null && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canonical(v[k])])) : v);

/**
 * Git bytes for the operator's (or the publish job's) checkout at `cwd`,
 * never an inherited `GIT_DIR`/`GIT_WORK_TREE`/index: the certified reader's
 * explicit source adapter. The checkout must hold the signed commit and its
 * first parent; a missing object is a refusal, not a rebuild.
 */
export function sourceGitAt(cwd) {
  refuse(typeof cwd === "string" && cwd !== "", "the source Git adapter needs an explicit checkout");
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));
  return (args) => {
    const out = spawnSync("git", args, { cwd, env, encoding: "buffer", maxBuffer: 256 * 1024 * 1024 });
    refuse(out.status === 0, `git ${args.slice(0, 2).join(" ")} could not read the signed commit or its parent in ${cwd}`);
    return out.stdout;
  };
}

/**
 * A decision record exactly as `macos-evidence.mjs select` writes it, for a
 * reuse: the five record keys, then the v2 evidence document with exactly the
 * keys `collectEvidence` produces. A decision written before evidence carried
 * `signedBuildOrigin` and `coverage` (the 1.4.5 preflight's) is refused: its
 * coverage is unknown and is never inferred.
 */
export function parseDecision(bytes) {
  let record;
  try {
    record = JSON.parse(readSingleEntryZip(bytes, DECISION_ENTRY, DECISION_BYTES).toString("utf8"));
  } catch (error) {
    throw new Refused(`the decision artifact is not one strict ${DECISION_ENTRY}: ${error.message}`);
  }
  refuse(record !== null && typeof record === "object" && !Array.isArray(record) && sorted(record) === JSON.stringify(DECISION_RECORD_KEYS),
    `the decision has keys ${sorted(record)}; want exactly ${JSON.stringify(DECISION_RECORD_KEYS)}`);
  refuse(record.source === "reuse" && DECISION_MODES.includes(record.mode) && typeof record.reason === "string"
    && ISO.test(record.decidedAt ?? ""), `the decision chose ${JSON.stringify(record.source)} (${JSON.stringify(record.mode)}), not a reuse`);
  const ev = record.evidence;
  refuse(ev !== null && typeof ev === "object" && !Array.isArray(ev), "the decision carries no reuse evidence");
  refuse(ev.schema === EVIDENCE_SCHEMA && ev.signedBuildOrigin !== undefined && ev.coverage !== undefined,
    `the decision (evidence ${JSON.stringify(ev.schema)}) predates signedBuildOrigin/coverage evidence; `
    + "its signed-build execution and coverage are unknown and are not inferred");
  refuse(sorted(ev) === JSON.stringify(EVIDENCE_KEYS), `the decision evidence has keys ${sorted(ev)}; want exactly ${JSON.stringify(EVIDENCE_KEYS)}`);
  const o = ev.signedBuildOrigin;
  refuse(o !== null && typeof o === "object" && sorted(o) === '["attempt","execution","jobId"]'
    && Number.isSafeInteger(o.attempt) && o.attempt > 0 && Number.isSafeInteger(o.jobId) && o.jobId > 0
    && typeof o.execution === "string" && SHA256.test(o.execution), "the decision's signedBuildOrigin is malformed");
  const wf = ev.workflow;
  refuse(wf !== null && typeof wf === "object" && sorted(wf) === '["blob","id","path","shape"]' && wf.path === PRODUCER_PATH
    && PRODUCER_SHAPES.includes(wf.shape) && SHA40.test(wf.blob ?? "") && Number.isSafeInteger(wf.id), "the decision's workflow is malformed");
  const run = ev.run;
  refuse(run !== null && typeof run === "object" && sorted(run) === '["attempt","conclusion","createdAt","event","headBranch","id","runStartedAt"]'
    && Number.isSafeInteger(run.id) && Number.isSafeInteger(run.attempt) && run.attempt >= o.attempt && run.event === "push"
    && run.headBranch === "main" && run.conclusion === "success", "the decision's producer run is malformed");
  refuse(Array.isArray(ev.jobs) && ev.jobs.length > 0 && ev.jobs.every((j) => j !== null && typeof j === "object"
    && sorted(j) === '["completedAt","conclusion","id","name","runAttempt","startedAt"]'), "the decision's job list is malformed");
  const art = ev.artifact;
  refuse(art !== null && typeof art === "object" && sorted(art) === '["createdAt","digest","expiresAt","id","name","sizeInBytes"]'
    && art.name === `relayium-macos-signed-${ev.sha}-ci` && Number.isSafeInteger(art.id) && /^sha256:[0-9a-f]{64}$/.test(art.digest ?? ""),
  "the decision's signed artifact is malformed");
  refuse(ev.files !== null && typeof ev.files === "object" && sorted(ev.files) === JSON.stringify([...PAYLOAD_FILES].sort())
    && Object.values(ev.files).every((v) => typeof v === "string" && SHA256.test(v)), "the decision's payload hashes are malformed");
  try {
    validateCoverage(ev.coverage);
  } catch (error) {
    throw new Refused(`the decision's coverage: ${error.message}`);
  }
  return record;
}

/** A step of a job, exactly once and successful, as a whole-second window widened by the API skew. */
function stepWindow(job, name, where) {
  const ran = (job.steps ?? []).filter((s) => s?.name === name);
  refuse(ran.length === 1 && ran[0].status === "completed" && ran[0].conclusion === "success",
    `${where} did not run "${name}" exactly once successfully`);
  const from = Date.parse(ran[0].started_at);
  const to = Date.parse(ran[0].completed_at);
  refuse(Number.isFinite(from) && Number.isFinite(to) && from <= to, `${where} "${name}" has no readable window`);
  return [from - STEP_SKEW_MS, to + STEP_SKEW_MS];
}

/**
 * The publisher preflight's decision as an ORIGINAL execution: the decided
 * instant lies inside its "Select the signed-build source" step and the
 * artifact was created inside its "Upload the signed-build source decision"
 * step — the upload follows the selection, so the artifact's creation binds
 * to the Upload window, not the Select one.
 */
export function judgeDecisionTiming(preflight, { decidedAt, createdAt }) {
  const where = `preflight job ${preflight?.id}`;
  const [selectFrom, selectTo] = stepWindow(preflight, SELECT_STEP, where);
  const [uploadFrom, uploadTo] = stepWindow(preflight, UPLOAD_STEP, where);
  const decided = Date.parse(decidedAt);
  refuse(Number.isFinite(decided) && decided >= selectFrom && decided <= selectTo,
    `the decision says it was made at ${decidedAt}, outside the preflight's "${SELECT_STEP}" step`);
  const created = Date.parse(createdAt);
  refuse(Number.isFinite(created) && created >= uploadFrom && created <= uploadTo,
    `the decision artifact was created at ${createdAt}, outside the preflight's "${UPLOAD_STEP}" step`);
}

/**
 * The publisher preflight's decision artifact, authenticated: the ONE
 * artifact of the publisher run named for the source commit and some attempt
 * (and, at verify, exactly the frozen ten-field identity), its record equal to
 * the listing, unexpired at the machine clock NOW, its bytes the API digest, a
 * strict v2 reuse decision; the latest preflight is the original execution of
 * that attempt's preflight (`judgeExecutionOrigin`), which succeeded at both
 * the Select and Upload steps with the decision and its upload inside them.
 * Never re-selects: a second decision artifact (a re-executed preflight) is
 * refused, not resolved.
 */
async function proveDecision(api, ctx, frozen) {
  const { repo, repoId, sha, runId, attempt, jobs, time } = ctx;
  const named = new RegExp(`^relayium-macos-build-source-${sha}-attempt-([1-9][0-9]*)$`);
  const listed = (await paginate(api, `/repos/${repo}/actions/runs/${runId}/artifacts`, "artifacts"))
    .filter((a) => named.test(String(a?.name ?? "")));
  refuse(listed.length === 1, `publisher run ${runId} carries ${listed.length} signed-build source decisions for ${sha}; want exactly one`);
  const identity = artifactIdentityOf(listed[0]);
  refuse(identity !== null && identity.run_id === runId && identity.head_sha === sha && identity.repository_id === repoId
    && identity.head_repository_id === repoId, `decision artifact ${listed[0]?.id} is not the publisher run's at ${sha}`);
  refuse(frozen === null || JSON.stringify(identity) === JSON.stringify(frozen.identity),
    `decision artifact ${identity.id} is not the frozen decision ${frozen?.identity?.id} (replaced or changed)`);
  const record = await api.get(`/repos/${repo}/actions/artifacts/${identity.id}`);
  refuse(JSON.stringify(artifactIdentityOf(record)) === JSON.stringify(identity),
    `decision artifact ${identity.id} changed between the listing and its record`);
  refuse(listed[0].expired === false && record.expired === false && Date.parse(identity.expires_at) > time(),
    `decision artifact ${identity.id} has expired`);
  let zip;
  try {
    zip = await api.download(`/repos/${repo}/actions/artifacts/${identity.id}/zip`);
  } catch (error) {
    throw new Refused(`decision artifact ${identity.id} could not be downloaded (HTTP ${error?.status ?? "?"})`);
  }
  refuse(Buffer.isBuffer(zip) && `sha256:${sha256(zip)}` === identity.digest,
    `decision artifact ${identity.id}'s bytes do not hash to its API digest`);
  const decision = parseDecision(zip);
  const decisionAttempt = Number(named.exec(identity.name)[1]);
  const pre = jobs.filter((j) => j?.name === "preflight");
  refuse(pre.length === 1, `publisher run ${runId} attempt ${attempt} has ${pre.length} preflight job(s)`);
  const origin = await judgeExecutionOrigin(api, {
    repository: repo, runId, sha, workflowPath: PUBLISHER_PATH, jobName: "preflight",
    originalAttempt: decisionAttempt, latestAttempt: attempt, latestJob: pre[0],
  });
  judgeDecisionTiming(origin.job, { decidedAt: decision.decidedAt, createdAt: identity.created_at });
  return {
    frozen: { identity, attempt: decisionAttempt, preflight: sha256(Buffer.from(origin.identity)),
      decidedAt: decision.decidedAt, mode: decision.mode },
    evidence: decision.evidence,
  };
}

/**
 * The reused `macos.yml` push run, judged at its LATEST attempt with the
 * coverage the decision froze: same run identity and success as v1, the
 * roster under that coverage (whose intent `coverageOf` must agree with), the
 * signed build's ORIGINAL execution, and — when certified — the shared
 * historical reader (`verifyHistoricalCertifiedCoverage`) with the frozen
 * coverage REQUIRED, the explicit checkout-bound source Git adapter and the
 * fresh machine clock. Never a new selection: no age or headroom rule of a
 * new reuse decides anything here.
 */
async function judgeReusedProducer(api, ctx, { runId, originalAttempt, coverage }) {
  const { repo, repoId, sha, time, cwd } = ctx;
  const producer = await api.get(`/repos/${repo}/actions/runs/${runId}`);
  refuse(producer?.id === runId && producer?.head_sha === sha && producer?.event === "push"
    && producer?.head_branch === "main" && runPath(producer) === PRODUCER_PATH
    && producer?.repository?.id === repoId && producer?.head_repository?.id === repoId
    && producer?.status === "completed" && producer?.conclusion === "success"
    && Number.isSafeInteger(producer?.run_attempt) && producer.run_attempt >= 1,
  `the reused producer run ${runId} is not a successful macos.yml push run on main at ${sha}`);
  const latest = producer.run_attempt;
  const record = await api.get(`/repos/${repo}/actions/runs/${runId}/attempts/${latest}`);
  refuse(record?.id === runId && record?.run_attempt === latest && record?.head_sha === sha
    && record?.status === "completed" && record?.conclusion === "success",
  `attempt ${latest} of the reused producer run ${runId} is not a successful attempt of that run`);
  const jobs = await paginate(api, `/repos/${repo}/actions/runs/${runId}/attempts/${latest}/jobs`, "jobs");
  let shape;
  let blob;
  let roster;
  try {
    ({ shape, blob } = await readProducerShape(api, { repository: repo, sha }));
    const intent = coverageOf(jobs, shape);
    refuse(intent === coverage.mode,
      `the reused producer run ${runId} reads as ${intent} coverage; the decision froze ${coverage.mode}`);
    roster = judgeProducerRoster(jobs, { runId, sha, latestAttempt: latest, shape, coverage: coverage.mode });
  } catch (error) {
    if (error instanceof Refused) throw new Refused(`the reused producer run ${runId}: ${error.message}`);
    if (error instanceof Unavailable) throw new Refused(`the reused producer run ${runId} is not a proved signed build: ${error.message}`);
    throw new Refused(`the reused producer run ${runId}: ${PRODUCER_PATH} at ${sha} could not be read (${error?.status ?? error?.message ?? "?"})`);
  }
  const origin = await judgeExecutionOrigin(api, {
    repository: repo, runId, sha, workflowPath: PRODUCER_PATH, jobName: "signed-build",
    originalAttempt, latestAttempt: latest, latestJob: roster.jobs[EXPECTED_JOBS.findIndex((e) => e.id === "signed-build")],
  });
  if (coverage.mode === COVERAGE_CERTIFIED) {
    // The certificate describes the tooling of the witness attempt; a signed
    // build executed in any other attempt ran on tooling nothing certified.
    refuse(origin.attempt === coverage.witness.attempt,
      `signed-build executed in attempt ${origin.attempt}, but the certified coverage is of attempt ${coverage.witness.attempt}`);
    // The operator's checkout holds the signed commit AND its first parent —
    // the base every source-proof kind derives its scope from — read through
    // the explicit adapter, before the shared reader runs.
    const sourceGit = sourceGitAt(cwd);
    const parents = sourceGit(["cat-file", "commit", sha]).toString("utf8").split("\n\n")[0].split("\n")
      .filter((l) => l.startsWith("parent ")).map((l) => l.slice(7));
    refuse(parents.length === 1 && SHA40.test(parents[0]), `the signed commit ${sha} has no single parent`);
    sourceGit(["cat-file", "-e", `${parents[0]}^{commit}`]);
    await verifyHistoricalCertifiedCoverage(api, {
      repository: repo, repositoryId: repoId, sha, run: producer,
      rosterJobs: EXPECTED_JOBS.map((e, i) => ({ id: e.id, job: roster.jobs[i] })),
      evidenceJob: roster.auxiliaryJobs[AUXILIARY_JOBS.indexOf(EVIDENCE_JOB)],
      certifyJob: roster.auxiliaryJobs[AUXILIARY_JOBS.indexOf(CERTIFY_JOB)],
      expectedCoverage: coverage, clock: time, sourceGit,
    });
  }
  return { latest, shape, blob, origin };
}

/**
 * The exact signed-build chain behind the notarized provenance, derived from
 * authoritative reads only, and — when `frozen` (a record's `signedBuild`) is
 * given — required to be byte-for-byte that frozen chain.
 *
 *  - publisher-build: provenance `notarizedBy.signedBuildSource` is `build`;
 *    the publisher's own `build / ` call judged whole at the immutable source
 *    (executed coverage), and its signed-build's original execution.
 *  - main-push: `reuse`; the chain the notarize-stage readback consumed is the
 *    preflight decision (`proveDecision`), whose evidence must name exactly the
 *    provenance's producer run, signed-build attempt, payload hashes, version,
 *    build and toolchain; the producer is then re-proved with the DECISION's
 *    coverage (`judgeReusedProducer`) and must yield the decision's signed
 *    execution, job, shape and workflow blob. Nothing is re-selected.
 *
 * Returns `{ signedBuild, anchor }`; the anchor adds the producer's latest
 * attempt so a start/end comparison sees a re-run.
 */
async function judgeSignedBuild(api, ctx, frozen) {
  const { repo, sha, runId, attempt, provenance, jobs } = ctx;
  const kind = provenance.notarizedBy.signedBuildSource === "build" ? "publisher-build" : "main-push";
  refuse(frozen === null || frozen.kind === kind,
    `the notarized provenance names a ${kind} signed build; the record froze ${frozen?.kind}`);
  const claimed = /^[1-9][0-9]*$/.test(provenance.runAttempt) ? Number(provenance.runAttempt) : NaN;
  let signedBuild;
  let latest;
  if (kind === "publisher-build") {
    const built = jobs.filter((j) => String(j?.name ?? "").startsWith("build / "));
    const proof = await judgeImmutableProducer(api, {
      repo, sha, jobs: built, runId, latestAttempt: attempt, prefix: "build / ", called: true,
      what: `publisher run ${runId}'s own build`,
    });
    const origin = await judgeExecutionOrigin(api, {
      repository: repo, runId, sha, workflowPath: PUBLISHER_PATH, jobName: "build / signed-build",
      originalAttempt: claimed, latestAttempt: attempt, latestJob: proof.signed,
    });
    signedBuild = { kind, runId, originalAttempt: origin.attempt, execution: sha256(Buffer.from(origin.identity)),
      shape: proof.shape, coverage: { mode: COVERAGE_EXECUTED }, decision: null, signedArtifact: null };
    latest = attempt;
  } else {
    const decision = await proveDecision(api, ctx, frozen?.decision ?? null);
    const ev = decision.evidence;
    const o = ev.signedBuildOrigin;
    refuse(ev.repository === repo && ev.repositoryId === ctx.repoId && ev.sha === sha,
      "the decision evidence names another repository or commit");
    refuse(String(ev.run.id) === provenance.runId && o.attempt === claimed,
      `the decision reused run ${ev.run.id} attempt ${o.attempt}; the notarized provenance names ${provenance.runId} attempt ${provenance.runAttempt}`);
    refuse(ev.files["Relayium.dmg"] === provenance.signedDmgSha256
      && ev.files["release-tools/generate_appcast"] === provenance.generateAppcastSha256,
    "the decision's signed payload is not the package the notarized provenance names");
    refuse(ev.version === provenance.version && ev.build === provenance.build
      && JSON.stringify(canonical(ev.toolchain)) === JSON.stringify(canonical(provenance.toolchain)),
    "the decision's version, build or toolchain is not the notarized provenance's");
    const producer = await judgeReusedProducer(api, ctx, { runId: ev.run.id, originalAttempt: o.attempt, coverage: ev.coverage });
    refuse(sha256(Buffer.from(producer.origin.identity)) === o.execution && producer.origin.job.id === o.jobId,
      "the reused signed-build execution is not the one the decision froze");
    refuse(producer.shape === ev.workflow.shape && producer.blob === ev.workflow.blob,
      "the producer workflow at the source is not the one the decision froze");
    refuse(producer.latest >= ev.run.attempt, `the reused producer run ${ev.run.id} is at attempt ${producer.latest}, before the decision's`);
    signedBuild = { kind, runId: ev.run.id, originalAttempt: o.attempt, execution: o.execution, shape: ev.workflow.shape,
      coverage: ev.coverage, decision: decision.frozen,
      signedArtifact: { id: ev.artifact.id, name: ev.artifact.name, digest: ev.artifact.digest } };
    latest = producer.latest;
  }
  refuse(frozen === null || JSON.stringify(signedBuild) === JSON.stringify(frozen),
    "the signed-build chain read back now differs from the chain the handoff froze");
  return { signedBuild, anchor: JSON.stringify([signedBuild, latest]) };
}

/** Local files the operator will upload or hand on, byte-equal to the archive. */
function compareLocal(files, artifactDir) {
  for (const [rel, bytes] of files) {
    refuse(readRegular(join(artifactDir, rel)).equals(bytes),
      `the local ${rel} is not the authenticated artifact's ${rel}`);
  }
}

/**
 * The artifact, end to end: record identity against the API, the archive
 * against the API digest, typed provenance against the publisher run, and the
 * local files against the archive.
 */
/**
 * The mutable publisher-side state the verdict depends on: the publisher run
 * (latest attempt, success, its notarize-stage and publish jobs) and the
 * artifact record (id, name, run, digest, creation, expiry against `now`).
 * Read at the start of `verify` and again at its very end.
 */
async function judgePublisherState(api, record, now) {
  const repo = record.repository.name;
  const state = await judgePublisher(api, {
    repo, repoId: record.repository.id, sha: record.source.sha, runId: record.publisher.runId,
    attempt: record.publisher.attempt, artifactId: record.artifact.id, name: record.artifact.name, terminal: true,
  });
  const { art } = state;
  refuse(art.digest === record.artifact.digest, `artifact ${art.id} digest ${art.digest} is not ${record.artifact.digest}`);
  refuse(art.created_at === record.artifact.createdAt, `artifact ${art.id} creation time changed`);
  refuse(art.expired === false && art.expires_at === record.artifact.expiresAt && Date.parse(art.expires_at) > now,
    `artifact ${art.id} is expired or its expiry changed`);
  return state;
}

/**
 * The execution anchors: the publisher's notarize-stage and the signed build,
 * each proved to the ORIGINAL execution its provenance names. Judged at the
 * start of `verify` and again at its end, where they must be identical.
 */
async function judgeOrigins(api, record, { art, notarize, jobs, files }, { cwd, time }) {
  const repo = record.repository.name;
  const ids = { repo, repoId: record.repository.id, sha: record.source.sha, runId: record.publisher.runId,
    attempt: record.publisher.attempt };
  const { provenance, origin } = await judgeNotaryOrigin(api, { ...ids, art, notarize, files });
  if (record.schema === HANDOFF_SCHEMA) {
    // v2: the whole frozen signed-build chain, re-derived and compared.
    const chain = await judgeSignedBuild(api, { ...ids, provenance, jobs, cwd, time }, record.signedBuild);
    return { provenance, producer: null, anchors: JSON.stringify([origin.attempt, origin.identity, chain.anchor]) };
  }
  // v1: executed-only, exactly as such records were always verified.
  const producer = await judgeBuildSource(api, { ...ids, provenance, jobs });
  return { provenance, producer, anchors: JSON.stringify([origin.attempt, origin.identity, producer?.attempt ?? null, producer?.origin ?? null]) };
}

async function verifyArtifact(api, record, { artifactDir, archive, now, cwd, time }) {
  const repo = record.repository.name;
  const state = await judgePublisherState(api, record, now);
  const files = await fetchArchive(api, repo, state.art, archive);
  const { provenance, producer: source, anchors } = await judgeOrigins(api, record, { ...state, files }, { cwd, time });
  const producer = source?.built ? null : source;
  refuse(provenance.version === record.release.version && provenance.build === String(record.release.build),
    `the artifact is ${provenance.version} (${provenance.build}), not ${record.release.version} (${record.release.build})`);
  refuse(sha256(files.get("Relayium.dmg")) === record.dmg.sha256, "the authenticated artifact's DMG is not the handed-off DMG");
  for (const [path, rel] of Object.entries(ARTIFACT_PATHS)) {
    refuse(sha256(files.get(rel)) === record.derived[path], `the artifact's ${rel} is not the handed-off ${path}`);
  }
  compareLocal(files, artifactDir);
  return { files, provenance, producer, anchors };
}

// ── the release ─────────────────────────────────────────────────────────────

/**
 * Every release, drafts included (an authenticated list is the only place a
 * draft appears), read to its end twice: GitHub's release list carries no
 * total, so a list whose ids differ between two complete reads, or one that
 * never ends, is ambiguous and refused.
 */
async function listReleases(api, repo) {
  const readAll = async () => {
    const out = [];
    for (let page = 1; ; page += 1) {
      refuse(page <= 20, "the release list did not end within 20 pages");
      const body = await api.get(`/repos/${repo}/releases?per_page=100&page=${page}`);
      refuse(Array.isArray(body) && body.length <= 100, "the release list is unreadable");
      out.push(...body);
      if (body.length < 100) break;
    }
    return out;
  };
  const first = await readAll();
  const second = await readAll();
  const ids = (list) => JSON.stringify(list.map((r) => r?.id));
  refuse(ids(first) === ids(second), "the release list changed between two complete reads; its contents are ambiguous");
  return first;
}

/**
 * Tag and release state for the record. Absent, or a published, non-draft,
 * non-prerelease release on a tag that resolves to the notarized source with
 * the exact title, notes and three assets — each downloaded by its asset id
 * and byte-compared with the authenticated artifact — and not the `latest`
 * alias. Nothing here creates anything.
 */
async function verifyRelease(api, record, files) {
  const repo = record.repository.name;
  const tag = record.release.tag;
  const tagRef = await api.getOptional(`/repos/${repo}/git/ref/tags/${tag}`);
  const releases = await listReleases(api, repo);
  const named = releases.filter((r) => r?.tag_name === tag);
  refuse(named.length <= 1, `${named.length} releases name ${tag}`);
  const byTag = await api.getOptional(`/repos/${repo}/releases/tags/${tag}`);
  if (named.length === 1) {
    refuse(named[0].draft === false && named[0].prerelease === false, `${tag} exists as a draft or prerelease`);
    refuse(byTag?.id === named[0].id, `the release list and the tag lookup disagree about ${tag}`);
  } else {
    refuse(byTag === null, `the tag lookup finds a ${tag} release the complete list does not`);
  }
  if (tagRef === null) {
    refuse(named.length === 0, `a release names ${tag} but the tag is absent`);
    return "absent";
  }
  let target = tagRef?.object?.sha;
  if (tagRef?.object?.type === "tag") {
    const annotated = await api.get(`/repos/${repo}/git/tags/${target}`);
    refuse(annotated?.object?.type === "commit", `${tag} is an annotated tag that does not point at a commit`);
    target = annotated.object.sha;
  } else {
    refuse(tagRef?.object?.type === "commit", `${tag} does not point at a commit`);
  }
  refuse(target === record.source.sha, `${tag} already targets ${target}, not the notarized source ${record.source.sha}`);
  if (named.length === 0) return "tag-only";
  const release = await api.get(`/repos/${repo}/releases/${named[0].id}`);
  const plan = record.releasePlan;
  refuse(release?.id === named[0].id && release?.tag_name === tag && release?.draft === false && release?.prerelease === false,
    `release ${named[0].id} changed while it was read`);
  refuse(release.name === plan.title, `${tag} is titled ${JSON.stringify(release.name)}, not ${JSON.stringify(plan.title)}`);
  refuse(release.body === plan.notes, `${tag}'s notes are not the handed-off notes`);
  const assets = release.assets ?? [];
  refuse(JSON.stringify(assets.map((a) => a?.name).sort()) === JSON.stringify([...plan.assets].sort()),
    `${tag} carries assets [${assets.map((a) => a?.name).join(", ")}], not exactly [${plan.assets.join(", ")}]`);
  const local = { "Relayium.dmg": "Relayium.dmg", "Relayium.dmg.sha256": "Relayium.dmg.sha256",
    "appcast.xml": "release-web/public/apps/macos/appcast.xml" };
  for (const asset of assets) {
    const want = files.get(local[asset.name]);
    refuse(asset.state === "uploaded" && asset.size === want.length, `${tag} asset ${asset.name} is not a complete upload`);
    let bytes;
    try {
      bytes = await api.download(`/repos/${repo}/releases/assets/${asset.id}`, { accept: "application/octet-stream" });
    } catch (error) {
      throw new Refused(`${tag} asset ${asset.name} could not be downloaded (HTTP ${error?.status ?? "?"})`);
    }
    refuse(Buffer.isBuffer(bytes) && bytes.equals(want), `the existing ${tag} asset ${asset.name} is not the notarized original`);
  }
  const latest = await api.getOptional(`/repos/${repo}/releases/latest`);
  refuse(latest?.tag_name !== tag, `${tag} is the repository's latest release; the plan says latest=false`);
  return "published-identical";
}

// ── verify ──────────────────────────────────────────────────────────────────

/**
 * Read-only verification before one operator write.
 *
 *  stage=main    — before fast-forwarding main to the candidate: main still
 *                  equals base, the branch still equals head, the gate is the
 *                  record's run at its latest attempt, green, and ran exactly
 *                  the lanes BASE's selector requires; the candidate is one
 *                  server-authentic commit on base inside BASE's scope.
 *  stage=release — before creating the release: main IS the candidate head
 *                  (frozen) or still the main the record found (already
 *                  delivered, whose delivering commit's gate run is read,
 *                  cross-bound and judged — see requireDeliveredGate), and
 *                  the tag/release is absent or already exactly this release.
 *
 * Both stages authenticate the artifact archive against the API digest and
 * compare every local file with it. main and the candidate branch are read at
 * the start and again at the end; a change in between is a refusal. That is
 * all a read-only verifier can promise: the operator's later write still
 * races an ordinary push, and a non-forced push is what loses that race.
 */
export async function verifyHandoff(api, record, { stage, cwd, artifactDir, archive, now, clock }) {
  refuse(STAGES.includes(stage), `stage ${JSON.stringify(stage)} is not one of ${STAGES.join("/")}`);
  // The clock is the machine's. Tests may inject a fixed instant or a clock
  // function through this call; the command line offers neither.
  const time = clock ?? (now === undefined ? Date.now : () => now);
  const repo = record.repository.name;
  const repoInfo = await api.get(`/repos/${repo}`);
  refuse(repoInfo?.id === record.repository.id && repoInfo?.full_name === repo,
    `repository ${repo} is not id ${record.repository.id}`);
  const readMain = async () => {
    const ref = await api.get(`/repos/${repo}/git/ref/heads/main`);
    refuse(SHA40.test(ref?.object?.sha ?? "") && ref?.object?.type === "commit", "main does not resolve to a commit");
    return ref.object.sha;
  };
  const cand = record.candidate;
  const readBranch = async () => (cand.state === "frozen"
    ? (await api.getOptional(`/repos/${repo}/git/ref/heads/${cand.branch}`))?.object?.sha ?? null : null);
  const main = await readMain();
  const branch = await readBranch();

  const { files, provenance, producer, anchors } = await verifyArtifact(api, record, { artifactDir, archive, now: time(), cwd, time });

  const sourceTree = await workflowsTree(api, repo, record.source.sha);
  refuse(sourceTree === record.source.workflowsTree, "the source commit's workflows tree is not the recorded one");
  await authenticCommit(api, repo, record.source.sha, cwd);
  await authenticCommit(api, repo, main, cwd);
  refuse(isAncestor(record.source.sha, main, cwd), `the source ${record.source.sha} is not an ancestor of main ${main}`);

  let deliveredAt;
  let gate;
  if (cand.state === "frozen") {
    const base = await authenticCommit(api, repo, cand.base, cwd);
    const head = await authenticCommit(api, repo, cand.head, cwd);
    refuse(base.tree.length === 40 && head.parents.length === 1 && head.parents[0] === cand.base,
      `the candidate has parents [${head.parents.join(", ")}]; want exactly [${cand.base}]`);
    refuse(head.tree === cand.tree, "the candidate commit does not carry the recorded tree");
    const paths = [...new Set(changedPaths(cand.base, cand.head, cwd).map((e) => e.path))].sort();
    refuse(JSON.stringify(paths) === JSON.stringify([...cand.changedPaths].sort()),
      "the candidate's changed paths are not the recorded ones");
    gate = { runId: record.gate.runId, attempt: record.gate.attempt, branch: cand.branch, head: cand.head };
    await judgeCandidateGate(api, record, { base: cand.base, paths, gate, cwd });
    if (stage === "main") {
      refuse(main === cand.base, `main is ${main}, not the candidate base ${cand.base}; regenerate the candidate`);
      refuse(branch === cand.head, `${cand.branch} is ${branch}, not ${cand.head}`);
    } else {
      refuse(main === cand.head, `main is ${main}, not the delivered candidate ${cand.head}; the release follows the exact delivery`);
    }
    deliveredAt = [cand.head];
  } else {
    refuse(stage === "release", "an already-delivered handoff has nothing to fast-forward");
    refuse(main === cand.base, `main is ${main}, not the main ${cand.base} this already-delivered record was written against`);
    const delivered = await requireDeliveredGate(api, record, cand.base, cwd);
    gate = delivered.gate;
    deliveredAt = [delivered.commit, cand.base];
  }

  for (const at of deliveredAt) {
    const drift = changedPaths(record.source.sha, at, cwd).map((e) => e.path).filter(isNativeInput);
    refuse(drift.length === 0, `native inputs differ between the notarized source and ${at}: ${drift.join(", ")}`);
    for (const [path, rel] of Object.entries(ARTIFACT_PATHS)) {
      refuse(git(["show", `${at}:${path}`], cwd).equals(files.get(rel)),
        `${path} at ${at} is not the authenticated artifact's ${rel}`);
    }
  }

  const tag = stage === "release" ? await verifyRelease(api, record, files) : "not-checked";

  // End re-read, after the slow downloads and the release readback: the
  // publisher run, the artifact (expiry against the clock NOW), the gate and
  // the reused producer are still exactly what was judged, and main and the
  // candidate branch have not moved. This narrows, but cannot close, the race
  // with a later write; a non-forced push is what loses that race.
  const endState = await judgePublisherState(api, record, time());
  await judgeGateAgain(api, record, gate);
  if (producer !== null) {
    const again = await judgeProducer(api, {
      repo, repoId: record.repository.id, sha: record.source.sha, provenance,
    });
    refuse(again.attempt === producer.attempt, `the reused producer run ${producer.runId} is now attempt ${again.attempt}, not ${producer.attempt}`);
  }
  // The original executions, re-proved from the already-verified bytes: the
  // same attempts, the same jobs' times and steps.
  const endAnchors = (await judgeOrigins(api, record, { ...endState, files }, { cwd, time })).anchors;
  refuse(endAnchors === anchors, "the notarization or signed-build execution changed while the handoff was being verified");
  refuse(await readMain() === main, "main moved while the handoff was being verified");
  refuse(await readBranch() === branch, "the candidate branch moved while the handoff was being verified");
  // The last word, after every API, proof and ref read: the frozen retained
  // chain must still be unexpired at a fresh machine clock read. A slow final
  // answer may not carry an expired chain into a verified verdict.
  expiryAtEnd(record, time(), "the handoff verification finished");
  return { stage, main, candidate: cand.state, tag, notarized: true, gate: { runId: gate.runId, attempt: gate.attempt },
    verifiableUntil: verifiableUntil(record) };
}

/**
 * A candidate's gate: the base-owned scope accepts the change set, the run is
 * the latest-attempt, green, dispatched gate on exactly this branch and head,
 * and its job graph is the complete BASE-derived roster for the BASE
 * selection of these paths.
 */
async function judgeCandidateGate(api, record, { base, paths, gate, cwd }) {
  const judges = await loadBaseJudges(base, cwd);
  try {
    const scope = judges.checkScope(paths);
    refuse(scope.ok, `the candidate is outside the base-owned release-metadata scope: ${scope.problems.join("; ")}`);
    await judgeGateRun(api, {
      repository: record.repository.name, repositoryId: record.repository.id, branch: gate.branch, head: gate.head,
      runId: gate.runId, attempt: gate.attempt,
    });
    const expected = gate.allLanes ? judges.allLanes() : judges.expectedLanes(paths);
    await judgeGateLanes(api, {
      repository: record.repository.name, runId: gate.runId, attempt: gate.attempt, head: gate.head, expected, judges,
    });
  } finally {
    judges.cleanup();
  }
}

/** The gate run, re-read: still that attempt, completed and green. */
async function judgeGateAgain(api, record, gate) {
  const run = await api.get(`/repos/${record.repository.name}/actions/runs/${gate.runId}`);
  refuse(run?.id === gate.runId && run?.head_sha === gate.head && run?.run_attempt === gate.attempt
    && run?.status === "completed" && run?.conclusion === "success",
  `merge-gate run ${gate.runId} changed while the handoff was being verified (now attempt ${run?.run_attempt}, ${run?.status}/${run?.conclusion})`);
}

/** The two `workflow_dispatch` gate modes whose run this verifier can judge, by the branch they ran on. */
const FROZEN_BRANCH = /^release-candidate\/macos-v([0-9]+(?:\.[0-9]+){1,2})-[1-9][0-9]*-[1-9][0-9]*$/;
const INTERNAL_BRANCH = /^internal-candidate\/([0-9a-f]{40})$/;

/**
 * An already-delivered record skips the frozen gate only because the metadata
 * reached main earlier, so the delivery itself must carry gate proof:
 *
 *  - the DELIVERING commit is the last first-parent commit on the recorded main
 *    that changed any of the five derived files (later docs-only commits on
 *    main are allowed and skipped); it must be a one-parent, server-authentic
 *    commit whose change set its parent's (the ORIGINAL base's) scope checker
 *    accepts, and whose derived files are the artifact's;
 *  - a completed, green `merge-gate` check run from GitHub Actions on it is
 *    only a pointer: its `details_url` names a run, and that run is then read
 *    and cross-bound — same check suite, the run's latest attempt lists the
 *    aggregate job whose id IS that check run, `merge-gate.yml`, a
 *    `workflow_dispatch` in this repository on the delivering commit, on a
 *    frozen release-candidate branch of this version (or an internal
 *    full-candidate branch, which runs every lane) — and judged exactly like a
 *    frozen candidate's gate: latest attempt, no red job, and the complete
 *    BASE-derived roster.
 *
 * Any other parent (a pull-request merge, a full bootstrap) is not judged here
 * and is refused; the documented fallback is a fresh frozen candidate.
 */
async function requireDeliveredGate(api, record, mainSha, cwd) {
  const repo = record.repository.name;
  const delivering = git(["log", "-1", "--first-parent", "--format=%H", mainSha, "--", ...DERIVED_FILES], cwd).toString().trim();
  refuse(SHA40.test(delivering), "main has no commit that delivered the release metadata");
  const head = await authenticCommit(api, repo, delivering, cwd);
  refuse(head.parents.length === 1, `the delivering commit ${delivering} has ${head.parents.length} parents; want exactly one`);
  const base = head.parents[0];
  await authenticCommit(api, repo, base, cwd);
  const paths = [...new Set(changedPaths(base, delivering, cwd).map((e) => e.path))].sort();
  const runs = await paginate(api, `/repos/${repo}/commits/${delivering}/check-runs?check_name=merge-gate`, "check_runs");
  const green = runs.filter((r) => r?.name === "merge-gate" && r?.head_sha === delivering && r?.app?.id === ACTIONS_APP_ID
    && r?.status === "completed" && r?.conclusion === "success");
  refuse(green.length > 0, `the delivering commit ${delivering} carries no successful merge-gate check run`);
  const reasons = [];
  for (const check of green) {
    try {
      const gate = await deliveredGateRun(api, record, { check, delivering });
      await judgeCandidateGate(api, record, { base, paths, gate, cwd });
      return { commit: delivering, base, gate };
    } catch (error) {
      if (!(error instanceof Refused)) throw error;
      reasons.push(`check run ${check.id}: ${error.message}`);
    }
  }
  throw new Refused(`no merge-gate check run on the delivering commit ${delivering} is backed by a judged gate run: ${reasons.join("; ")}`);
}

/** The run behind one green check run, authenticated record by record. */
async function deliveredGateRun(api, record, { check, delivering }) {
  const repo = record.repository.name;
  const link = /\/([^/]+\/[^/]+)\/actions\/runs\/([1-9][0-9]*)\/job\/([1-9][0-9]*)$/.exec(String(check.details_url ?? ""));
  refuse(link !== null && link[1] === repo && Number(link[3]) === check.id && Number.isSafeInteger(check.id),
    `check run ${check.id}'s details_url does not name a job of this repository with its own id`);
  const runId = Number(link[2]);
  const run = await api.get(`/repos/${repo}/actions/runs/${runId}`);
  refuse(run?.id === runId && run?.head_sha === delivering && runPath(run) === GATE_WORKFLOW_PATH
    && run?.event === "workflow_dispatch" && run?.repository?.id === record.repository.id
    && run?.head_repository?.id === record.repository.id && run?.repository?.fork === false,
  `run ${runId} is not a dispatched merge-gate.yml run of this repository on ${delivering}`);
  refuse(run.status === "completed" && run.conclusion === "success" && Number.isSafeInteger(run.run_attempt) && run.run_attempt >= 1,
    `merge-gate run ${runId} is ${run.status}/${run.conclusion}`);
  refuse(Number.isSafeInteger(check.check_suite?.id) && check.check_suite.id === run.check_suite_id,
    `check run ${check.id} is not in run ${runId}'s check suite`);
  const branch = String(run.head_branch ?? "");
  const frozen = FROZEN_BRANCH.exec(branch);
  const internal = INTERNAL_BRANCH.exec(branch);
  refuse((frozen !== null && frozen[1] === record.release.version) || internal !== null,
    `merge-gate run ${runId} ran on ${JSON.stringify(branch)}, neither a frozen ${record.release.tag} candidate nor an internal full candidate`);
  const jobs = await paginate(api, `/repos/${repo}/actions/runs/${runId}/attempts/${run.run_attempt}/jobs`, "jobs");
  const aggregate = jobs.filter((j) => j?.name === "merge-gate");
  refuse(aggregate.length === 1 && aggregate[0].id === check.id,
    `check run ${check.id} is not the aggregate job of run ${runId}'s latest attempt ${run.run_attempt}`);
  return { runId, attempt: run.run_attempt, branch, head: delivering, allLanes: internal !== null };
}

// ── emit (inside the publish job) ───────────────────────────────────────────

/**
 * Build the record from authoritative reads: the artifact this run uploaded,
 * downloaded by id and proven against its digest; its typed provenance; the
 * gate by unique dispatch; Git for the candidate. The local downloaded copy is
 * compared with the authenticated archive, never trusted on its own.
 */
export async function emitHandoff(api, env, { cwd, artifactDir, candidate, branch, dispatchedAt, now, clock }) {
  // The machine clock, read fresh for each check. Tests may inject a fixed
  // instant or a clock function through this call; the command line neither.
  const time = clock ?? (now === undefined ? Date.now : () => now);
  const repo = env.GITHUB_REPOSITORY;
  const repoId = Number(env.GITHUB_REPOSITORY_ID);
  const runId = Number(env.GITHUB_RUN_ID);
  const attempt = Number(env.GITHUB_RUN_ATTEMPT);
  const version = env.RELEASE_VERSION;
  const sha = env.GITHUB_SHA;
  refuse(Number.isInteger(repoId) && repoId > 0 && runId > 0 && attempt > 0 && SHA40.test(sha ?? "")
    && VERSION.test(version ?? ""), "the run identity is incomplete");
  const name = `relayium-macos-${sha}-${version}`;
  const { art, notarize, jobs } = await judgePublisher(api, { repo, repoId, sha, runId, attempt, name, terminal: false });
  refuse(art.expired === false && Date.parse(art.expires_at) > time(), `artifact ${art.id} is expired`);
  // Digest first, then the provenance names the original notarization, then
  // that execution is proved — a re-run publish job hands off a carried one.
  const files = await fetchArchive(api, repo, art, undefined);
  const { provenance } = await judgeNotaryOrigin(api, { repo, repoId, sha, runId, attempt, art, notarize, files });
  // The signed-build chain is FROZEN from what this run already consumed: the
  // publisher's own build, or the preflight's authenticated reuse decision —
  // never a new selection made now.
  const { signedBuild } = await judgeSignedBuild(api, { repo, repoId, sha, runId, attempt, provenance, jobs, cwd, time }, null);
  refuse(provenance.version === version, `the artifact is version ${provenance.version}, not ${version}`);
  compareLocal(files, artifactDir);
  let manifest;
  try {
    manifest = JSON.parse(files.get("release-web/native-releases.json").toString("utf8"));
  } catch (error) {
    throw new Refused(`the artifact's native-releases.json is not JSON: ${error.message}`);
  }
  refuse(manifest?.macos?.version === version && String(manifest?.macos?.build) === provenance.build,
    "the artifact's manifest does not name the provenance version and build");

  const main = git(["rev-parse", "HEAD"], cwd).toString().trim();
  const at = candidate || main;
  const derived = {};
  for (const [path, rel] of Object.entries(ARTIFACT_PATHS)) {
    const bytes = git(["show", `${at}:${path}`], cwd);
    refuse(bytes.equals(files.get(rel)), `the candidate's ${path} is not the artifact's ${rel}`);
    derived[path] = sha256(bytes);
  }

  let cand = { state: "already-delivered", base: main, head: null, tree: null, branch: null, changedPaths: [] };
  let gate = { runId: null, attempt: null, dispatchedAt: null };
  if (candidate) {
    const { parents, tree } = commitHeader(candidate, cwd);
    refuse(parents.length === 1, "the frozen candidate is not a one-parent commit");
    cand = {
      state: "frozen", base: parents[0], head: candidate, tree, branch,
      changedPaths: [...new Set(changedPaths(parents[0], candidate, cwd).map((e) => e.path))].sort(),
    };
    const found = await findGateRun(api, { repository: repo, repositoryId: repoId, branch, head: candidate, since: dispatchedAt });
    refuse(found !== null, `no merge-gate run was found for ${candidate}`);
    gate = { runId: found.id, attempt: found.attempt, dispatchedAt };
  }
  const sourceTree = await workflowsTree(api, repo, sha);
  // Read once, after the last API answer: the record is stamped with it and
  // is only emitted while its whole retained chain is still unexpired then.
  const handedOffAt = time();
  const record = {
    schema: HANDOFF_SCHEMA,
    repository: { id: repoId, name: repo },
    release: {
      version, build: Number(provenance.build), channel: "stable",
      architectures: manifest.macos.architectures, tag: `macos-v${version}`,
    },
    source: { sha, workflowsTree: sourceTree },
    publisher: { runId, attempt, workflow: ".github/workflows/macos-release.yml" },
    artifact: {
      id: art.id, name, digest: art.digest, createdAt: art.created_at, expiresAt: art.expires_at, workflowRunId: runId,
    },
    dmg: { sha256: sha256(files.get("Relayium.dmg")), provenanceSha: provenance.sha, notarized: provenance.notarized },
    candidate: cand,
    derived,
    gate,
    releasePlan: {
      title: `Relayium for macOS ${version}`, notes: releaseNotes(runId),
      assets: [...RELEASE_ASSETS], target: sha, latest: false,
    },
    handedOffAt: new Date(handedOffAt).toISOString(),
    signedBuild,
  };
  expiryAtEnd(record, handedOffAt, "the handoff record was emitted");
  // Round-trip through the strict parser: the producer may not write a record
  // the verifier would refuse.
  return parseHandoff(JSON.stringify(record));
}

/** The step summary. Truthful by construction: it never says "published". */
export function handoffSummary(record) {
  const lines = [
    `## macOS ${record.release.version} (${record.release.build}) — HANDED OFF / NOT PUBLISHED`,
    "",
    "This run did NOT advance `main` and did NOT create a GitHub Release. A green run here is a staged handoff, not a release.",
    "",
    `- Notarized source: \`${record.source.sha}\``,
    `- Artifact: ${record.artifact.name} (id ${record.artifact.id}, ${record.artifact.digest}, expires ${record.artifact.expiresAt})`,
  ];
  if (record.candidate.state === "frozen") {
    lines.push(`- Candidate: \`${record.candidate.head}\` on base \`${record.candidate.base}\`, branch \`${record.candidate.branch}\``);
    lines.push(`- Merge gate: run ${record.gate.runId} attempt ${record.gate.attempt} (dispatched, not awaited)`);
  } else {
    lines.push(`- Candidate: none — main \`${record.candidate.base}\` already carries this release's metadata`);
  }
  const sb = record.signedBuild;
  if (sb) {
    lines.push(sb.kind === "publisher-build"
      ? `- Signed build: this run's own build (attempt ${sb.originalAttempt}), executed coverage`
      : `- Signed build: reused macos.yml run ${sb.runId} attempt ${sb.originalAttempt}, ${sb.coverage.mode} coverage, `
        + `frozen from preflight decision artifact ${sb.decision.identity.id} (attempt ${sb.decision.attempt})`);
  }
  const until = verifiableUntil(record);
  lines.push(`- Verifiable until ${until}: the earliest expiry of the artifacts \`verify\` must re-read. After it, \`verify\` `
    + "refuses and this record proves nothing more; publishing then needs the documented manual fallback, not this record.");
  lines.push("", "Operator: run `node scripts/release/macos-handoff.mjs verify --stage main|release …` before each write. See docs/MACOS-RELEASE-POLICY.md.");
  return `${lines.join("\n")}\n`;
}

// ── command ─────────────────────────────────────────────────────────────────

function parseArgs(argv, allowed) {
  const out = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i];
    const value = argv[i + 1];
    refuse(key?.startsWith("--") && value !== undefined, `expected --flag value pairs, got ${key}`);
    // No clock override and no other unknown flag: production time is the
    // machine's, never a value an operator can backdate an expiry with.
    refuse(allowed.includes(key.slice(2)), `unknown flag ${key}`);
    refuse(!(key.slice(2) in out), `flag ${key} given twice`);
    out[key.slice(2)] = value;
  }
  return out;
}

export async function main(argv, env = process.env,
  apiFactory = () => githubApi({ token: env.GH_TOKEN, server: env.GITHUB_API_URL || undefined })) {
  const [command, ...rest] = argv;
  if (command === "workflows-preflight") {
    const args = parseArgs(rest, ["mode"]);
    const result = await compareWorkflows(apiFactory(), { repository: env.GITHUB_REPOSITORY, sha: env.GITHUB_SHA, mode: args.mode });
    process.stderr.write(result.match
      ? "source and main carry the same .github/workflows tree (this does not prove push or release permission)\n"
      : `REPORT: source workflows tree ${result.source} differs from main's ${result.current}; operator delivery proceeds, workflow-mode writes would meet a known refusal condition\n`);
    process.stdout.write(`workflows-preflight-ok ${result.match ? "match" : "mismatch"}\n`);
    return 0;
  }
  if (command === "emit") {
    const args = parseArgs(rest, ["candidate", "branch", "since", "artifact-dir", "record", "summary"]);
    const record = await emitHandoff(apiFactory(), env, {
      cwd: process.cwd(), artifactDir: resolve(args["artifact-dir"]),
      candidate: args.candidate === "-" ? "" : args.candidate, branch: args.branch, dispatchedAt: args.since,
    });
    writeFileSync(resolve(args.record), `${JSON.stringify(record, null, 2)}\n`, { flag: "wx" });
    writeFileSync(resolve(args.summary), handoffSummary(record), { flag: "a" });
    process.stdout.write(`handoff-emitted ${record.candidate.state}\n`);
    return 0;
  }
  if (command === "verify") {
    const args = parseArgs(rest, ["record", "stage", "artifact-dir", "archive"]);
    refuse(args.record && args["artifact-dir"], "verify needs --record and --artifact-dir");
    const record = parseHandoff(readRegular(resolve(args.record)).toString("utf8"));
    const result = await verifyHandoff(apiFactory(), record, {
      stage: args.stage, cwd: process.cwd(), artifactDir: resolve(args["artifact-dir"]),
      archive: args.archive ? resolve(args.archive) : undefined,
    });
    process.stdout.write(`handoff-verified ${result.stage} ${result.candidate} tag=${result.tag} verifiable-until=${result.verifiableUntil}\n`);
    return 0;
  }
  throw new Refused("usage: macos-handoff.mjs workflows-preflight|emit|verify --flag value …");
}

const invokedDirectly = (() => {
  try {
    return Boolean(process.argv[1]) && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();
if (invokedDirectly) {
  main(process.argv.slice(2)).then(
    (code) => { process.exitCode = code; },
    (error) => {
      // The message only: never a stack, a request header or an environment dump.
      process.stderr.write(`::error::${error instanceof Refused ? "" : "unexpected: "}${error.message}\n`);
      process.exitCode = 1;
    },
  );
}
