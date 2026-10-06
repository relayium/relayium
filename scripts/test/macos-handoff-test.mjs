// scripts/test/macos-handoff-test.mjs — executable controls for the macOS
// operator handoff (`scripts/release/macos-handoff.mjs`) and for the publish
// job's two delivery modes in `.github/workflows/macos-release.yml`.
//
// Offline. A real temporary Git repository supplies every commit, tree and
// diff; the GitHub API is an in-process fake whose Git-database answers are
// read from that same repository, so the workflows-tree walk and the verifier
// meet authentic tree objects rather than strings the test made up. Every
// family runs its valid world first, so a verifier that refused everything
// fails the positive control instead of passing the negatives.
//
// Run by `scripts/test/macos-publish-order-test.mjs` (`export async function
// run()`), and standalone: `node scripts/test/macos-handoff-test.mjs`.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import {
  EVIDENCE_SCHEMA, REQUIRED_STEPS, Refused, WITNESS_STEPS, crc32, executionIdentity, workflowShape,
} from "../release/macos-evidence.mjs";
import {
  ARTIFACT_PATHS, DERIVED_FILES, HANDOFF_SCHEMA, HANDOFF_SCHEMA_V1, compareWorkflows, sourceGitAt, verifiableUntil, dispatchGateRoster, emitHandoff, handoffSummary,
  isNativeInput, judgeGateLanes, loadBaseJudges, main as handoffMain, parseHandoff, releaseNotes, verifyHandoff,
} from "../release/macos-handoff.mjs";
import { LANES, selectLanes } from "../ci/select-lanes.mjs";
import { artifactIdentityOf } from "../ci/ci-evidence.mjs";
import { decide, readback } from "../release/macos-evidence.mjs";
import { PUBLISHER_RUN, handoffWorld, storedZip } from "./fixtures/macos-handoff-world.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const sha256 = (b) => createHash("sha256").update(b).digest("hex");
const REPO = "relayium/relayium";
const REPO_ID = 4242;
const PUB_RUN = 900;
const GATE_RUN = 777;
const ART_ID = 55;
const DECISION_ID = 56;
const VERSION = "1.4.6";
export const NOW = Date.parse("2026-10-05T12:00:00Z");

function git(cwd, ...args) {
  const out = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (out.status !== 0) throw new Error(`git ${args.join(" ")}: ${out.stderr}`);
  return out.stdout.trim();
}
function write(dir, rel, text) {
  mkdirSync(dirname(join(dir, rel)), { recursive: true });
  writeFileSync(join(dir, rel), text);
}
function commit(cwd, message) {
  git(cwd, "add", "-A");
  git(cwd, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", message);
  return git(cwd, "rev-parse", "HEAD");
}

/** A minimal stored-method ZIP writer (the PARSER under test is macos-evidence's). */
export function zipOf(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name, "latin1");
    const raw = Buffer.from(e.data ?? "");
    const crc = e.crc ?? crc32(raw);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(raw.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, raw);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE((3 << 8) | 20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(raw.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(((e.mode ?? 0o100644) << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += 30 + name.length + raw.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

/** The base-owned scope checker the fixture commits: exactly the metadata paths. */
const STRICT_CHECKER = `export function checkCandidateScope(paths) {
  const allowed = ${JSON.stringify([...DERIVED_FILES, "apps/README.md"])};
  const unexpected = paths.filter((p) => !allowed.includes(p));
  const missing = allowed.filter((p) => !paths.includes(p));
  const problems = [];
  if (unexpected.length) problems.push("unrelated files: " + unexpected.join(", "));
  if (missing.length) problems.push("incomplete: " + missing.join(", "));
  return { ok: problems.length === 0, problems };
}
`;
const PERMISSIVE_CHECKER = "export function checkCandidateScope() { return { ok: true, problems: [] }; }\n";

/** The notarized provenance exactly as notarize-stage finalizes it (reuse source). */
function provenanceFor(S, dmgSha, over = {}) {
  return {
    schema: "relayium-macos-signed-provenance/v2", repository: REPO, repositoryId: String(REPO_ID), sha: S,
    ref: "refs/heads/main", event: "push", runId: "321", runAttempt: "1",
    workflowRef: `${REPO}/.github/workflows/macos.yml@refs/heads/main`, workflowSha: S, releaseVersion: "",
    channel: "direct", arch: "arm64", teamId: "7PVYUG4YQS", version: VERSION, build: "43",
    shareExtensionVersion: VERSION, shareExtensionBuild: "43",
    toolchain: { xcode: "Xcode 16.4", swift: "Swift 6.1.2", macos: "15.7.9", runnerImage: "macos15/1" },
    signedBuildSource: "built", signedDmgSha256: "c".repeat(64), dmgSha256: dmgSha, generateAppcastSha256: "d".repeat(64),
    notarized: true, notarizedBy: { runId: String(PUB_RUN), runAttempt: "1", signedBuildSource: "reuse" },
    ...over,
  };
}

/** The eight artifact files, keyed by archive path. */
function artifactFiles(w, { dmg = Buffer.from("notarized dmg bytes"), provenance, provenanceOver } = {}) {
  const dmgSha = sha256(dmg);
  const files = new Map([
    ["Relayium.dmg", dmg],
    ["Relayium.dmg.sha256", Buffer.from(`${dmgSha}  Relayium.dmg\n`)],
    ["provenance.json", Buffer.from(JSON.stringify(provenance ?? provenanceFor(w.S, dmgSha, provenanceOver)))],
  ]);
  for (const [p, rel] of Object.entries(ARTIFACT_PATHS)) files.set(rel, Buffer.from(git(w.dir, "show", `${w.C}:${p}`) + "\n"));
  return files;
}
export function installArtifact(w, files) {
  rmSync(w.art, { recursive: true, force: true });
  for (const [rel, bytes] of files) write(w.art, rel, bytes);
  w.files = files;
  w.zip = zipOf([...files].map(([name, data]) => ({ name, data })));
}

/**
 * A repository: source S, main M (= S + unrelated docs), candidate C on M. S
 * carries the REAL lane selector and workflow filters plus a strict scope
 * checker, so the base-owned judges are loaded from authentic Git objects.
 */
/** The provenance of a signed package this publisher run BUILT through its own `build` call. */
const FRESH_BUILD_PROVENANCE = {
  runId: String(PUB_RUN), runAttempt: "1", event: "workflow_dispatch", releaseVersion: VERSION,
  workflowRef: `${REPO}/.github/workflows/macos-release.yml@refs/heads/main`,
  notarizedBy: { runId: String(PUB_RUN), runAttempt: "1", signedBuildSource: "build" },
};

export function world({ nativeDrift = false, workflowDrift = false, candidateExtra = null, freshBuild = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "mac-handoff-"));
  git(dir, "init", "-q", "-b", "main");
  cpSync(join(repoRoot, ".github/workflows"), join(dir, ".github/workflows"), { recursive: true });
  write(dir, ".github/workflows/a.yml", "name: a\n");
  for (const f of ["select-lanes.mjs", "web-lane-scope.mjs", "ci-evidence-registry.json"]) {
    write(dir, `scripts/ci/${f}`, readFileSync(join(repoRoot, "scripts/ci", f)));
  }
  write(dir, "web/scripts/macos-release-candidate.mjs", STRICT_CHECKER);
  write(dir, "apps/mac/App.swift", "// v1\n");
  write(dir, "apps/README.md", "old\n");
  for (const p of DERIVED_FILES) write(dir, p, `old ${p}\n`);
  const S = commit(dir, "source");
  write(dir, "docs/x.md", "later\n");
  if (nativeDrift) write(dir, "apps/mac/App.swift", "// v2\n");
  if (workflowDrift) write(dir, ".github/workflows/a.yml", "name: a2\n");
  const M = commit(dir, "main moves");
  for (const p of DERIVED_FILES) write(dir, p, `new ${p} ${VERSION}\n`);
  write(dir, "web/native-releases.json",
    `${JSON.stringify({ macos: { version: VERSION, build: 43, architectures: ["arm64"] } })}\n`);
  write(dir, "apps/README.md", `new ${VERSION}\n`);
  if (candidateExtra) candidateExtra(dir);
  const C = commit(dir, "release(mac): publish");
  git(dir, "checkout", "-q", "--detach", M);
  const w = { dir, art: join(dir, "..", `${dir.split("/").pop()}-artifact`), S, M, C };
  installArtifact(w, artifactFiles(w, { provenanceOver: freshBuild ? FRESH_BUILD_PROVENANCE : {} }));
  return w;
}

/**
 * What an honest dispatched merge gate reports for `selected`, with GitHub's
 * real job names: `<caller> / <job>` for each job of the called workflow, the
 * matrix and templated jobs expanded to the exact names the CI evidence
 * registry records (`macos / ui-smoke (app-shell, …)`, `go / race account
 * shard 3`), main-only auxiliaries skipped, the evidence job run, and an
 * unselected lane as its one skipped caller. Built from the repository's own
 * files by a plain scan — not by the module under test.
 */
const REGISTRY = JSON.parse(readFileSync(join(repoRoot, "scripts/ci/ci-evidence-registry.json"), "utf8"));
const CALLERS = [...LANES.map((l) => [l.id, l.workflow, true]), ["compat", "compat.yml", false], ["repo-hygiene", "repo-hygiene.yml", false]];
function laneJobIds(file) {
  const text = readFileSync(join(repoRoot, ".github/workflows", file), "utf8");
  return [...text.slice(text.indexOf("\njobs:\n")).matchAll(/^ {2}([a-z0-9-]+):\s*$/gm)].map((m) => m[1]);
}
export function honestGateJobs(selected) {
  const jobs = [["select", "success"]];
  for (const [id, file, conditional] of CALLERS) {
    if (conditional && !selected.has(id)) { jobs.push([id, "skipped"]); continue; }
    for (const job of laneJobIds(file)) {
      if (job === "screen" || job.startsWith("certify-")) jobs.push([`${id} / ${job}`, "skipped"]);
      else if (job === "evidence") jobs.push([`${id} / evidence`, "success"]);
      else for (const check of REGISTRY.lanes[id] ? REGISTRY.lanes[id].jobs[job].checks : [job]) jobs.push([`${id} / ${check}`, "success"]);
    }
  }
  jobs.push(["merge-gate", "success"]);
  return jobs;
}
function selectedFor(w) {
  const paths = git(w.dir, "diff", "--name-only", w.M, w.C).split("\n").filter(Boolean);
  return selectLanes(paths, { workflowsDir: join(w.dir, ".github/workflows") });
}
const gateJobsFor = (w) => honestGateJobs(selectedFor(w));

const MAC_UI = REGISTRY.lanes.macos.jobs["ui-smoke"].checks.map((c) => `macos / ${c}`);
const PRODUCER_JOBS = ["contract", "test", REGISTRY.lanes.macos.jobs["ui-smoke"].checks[0],
  REGISTRY.lanes.macos.jobs["ui-smoke"].checks[1], "signed-build"];
const PRODUCER_KINDS = ["contract", "test", "ui-smoke/app-shell", "ui-smoke/device-inbox", "signed-build"];
const EVIDENCE_HANDOVER = ["Keep the witness (reuse only)", "Hand the decision to the lane only once its witness is kept"];

/**
 * One attempt of `macos.yml` as the jobs API reports it when the CURRENT
 * adoption ran it in full: the three adoption jobs (main-only screen and
 * certify skipped; evidence run), and each gate job on its real runner with the
 * step names `macos.yml` gives it, timed, its witness prefix reported skipped.
 * `called` is a `workflow_call` from `macos-release.yml` with release inputs:
 * every name carries `build / `, the contract runs on macOS, and the evidence
 * job's push-only decision step is skipped. Built from the exported step
 * lists, which the evidence suite pins to `macos.yml` itself.
 */
export function producerRoster({ runId, sha, attempt = 1, start, called = false, firstId = 300 }) {
  const prefix = called ? "build / " : "";
  const at = (k) => new Date(Date.parse(start) + k * 1000).toISOString().replace(".000Z", "Z");
  const job = (kind, name, i) => {
    const base = { id: firstId + i, name: prefix + name, status: "completed", run_id: runId, head_sha: sha, run_attempt: attempt,
      runner_name: `GitHub Actions ${1000 + i}` };
    if (kind === "screen" || kind === "certify-macos") {
      return { ...base, conclusion: "skipped", started_at: start, completed_at: start, labels: [kind === "screen" ? "ubuntu-latest" : "macos-15"], steps: [] };
    }
    let n = 0;
    let k = 0;
    const step = (stepName, conclusion) => {
      k += 2;
      const ran = conclusion !== "skipped";
      return { number: ++n, name: stepName, status: "completed", conclusion,
        started_at: ran ? at(k) : null, completed_at: ran ? at(k + 1) : null };
    };
    const steps = [step("Set up job", "success")];
    if (kind === "evidence") {
      steps.push(step(REQUIRED_STEPS.evidence[0], called ? "skipped" : "success"));
      for (const h of EVIDENCE_HANDOVER) steps.push(step(h, "skipped"));
    } else {
      if (kind === "test" || kind.startsWith("ui-smoke")) for (const ws of WITNESS_STEPS) steps.push(step(ws, "skipped"));
      for (const r of REQUIRED_STEPS[kind]) steps.push(step(r, "success"));
    }
    steps.push(step("Complete job", "success"));
    const labels = kind === "evidence" || (kind === "contract" && !called) ? ["ubuntu-latest"] : ["macos-15"];
    return { ...base, conclusion: "success", started_at: start, completed_at: at(k + 2), labels, steps };
  };
  return [job("screen", "screen", 0), job("certify-macos", "certify-macos", 1), job("evidence", "evidence", 2),
    ...PRODUCER_JOBS.map((name, i) => job(PRODUCER_KINDS[i], name, 3 + i))];
}

/**
 * A fake API in GitHub's real response shapes. Git-database answers come from
 * the real repository; the artifact ZIP and release assets are real bytes.
 */
export function fakeApi(w, over = {}) {
  const state = {
    main: w.M,
    branch: w.C,
    gateAttempt: 1,
    gateJobs: gateJobsFor(w),
    publisherAttempt: 1,
    publisherStatus: ["completed", "success"],
    publishJob: ["completed", "success"],
    notarizeJob: ["completed", "success"],
    tag: null,
    releases: [],
    releaseById: {},
    assetBytes: {},
    latest: null,
    checkRuns: [],
    zipOverride: null,
    gateRunOver: {},
    producerAttempt: 1,
    producerJobs: null,
    ...over,
  };
  state.artifact = state.artifact ?? {
    id: ART_ID, name: `relayium-macos-${w.S}-${VERSION}`, digest: `sha256:${sha256(w.zip)}`, expired: false,
    created_at: "2026-10-05T11:40:00Z", expires_at: "2026-10-19T11:40:00Z", size_in_bytes: w.zip.length,
    workflow_run: { id: PUB_RUN, head_sha: w.S, repository_id: REPO_ID, head_repository_id: REPO_ID, head_branch: "main" },
  };
  // The candidate branch names the publisher attempt that emits it.
  const branchName = `release-candidate/macos-v${VERSION}-${PUB_RUN}-${state.publisherAttempt}`;
  const ids = { repository: { id: REPO_ID, fork: false }, head_repository: { id: REPO_ID, fork: false } };
  const gateRun = () => ({
    id: GATE_RUN, run_attempt: state.gateAttempt, head_sha: w.C, head_branch: branchName, event: "workflow_dispatch",
    path: ".github/workflows/merge-gate.yml", workflow_id: 9, status: "completed", conclusion: "success",
    created_at: "2026-10-05T11:59:00Z", check_suite_id: 5005, ...ids, ...state.gateRunOver,
  });
  // Executed jobs as the API reports them: own times, runner labels, and
  // timed step records (the execution identity a relabelled carry keeps).
  const executed = (start, end, labels) => ({
    started_at: start, completed_at: end, labels, runner_name: "GitHub Actions 1000021263",
    steps: [
      { number: 1, name: "Set up job", status: "completed", conclusion: "success", started_at: start, completed_at: start },
      { number: 2, name: "Work", status: "completed", conclusion: "success", started_at: start, completed_at: end },
      { number: 3, name: "Skipped", status: "completed", conclusion: "skipped", started_at: null, completed_at: null },
    ],
  });
  state.producerJobs = state.producerJobs ?? producerRoster({ runId: 321, sha: w.S, start: "2026-10-05T10:00:00Z" });
  // A fresh build: this publisher run's own `build / ` call, before notarization.
  state.buildJobs = state.buildJobs ?? producerRoster({ runId: PUB_RUN, sha: w.S, start: "2026-10-05T11:22:00Z", called: true, firstId: 500 });
  // The preflight's executed reuse decision, exactly as `select` writes it for
  // this world's producer run 321 (the v2 evidence with signedBuildOrigin and
  // executed coverage), zipped and served under its own artifact record.
  if (state.decisionZip === undefined) {
    const signed = state.producerJobs.find((j) => j.name === "signed-build");
    const text = git(w.dir, "show", `${w.S}:.github/workflows/macos.yml`) + "\n";
    const evidence = {
      schema: EVIDENCE_SCHEMA, repository: REPO, repositoryId: REPO_ID, sha: w.S,
      workflow: { id: 1, path: ".github/workflows/macos.yml", shape: workflowShape(text), blob: "f".repeat(40) },
      run: { id: 321, attempt: 1, event: "push", headBranch: "main", conclusion: "success", createdAt: "2026-10-05T10:00:00Z", runStartedAt: null },
      jobs: state.producerJobs.map((j) => ({ id: j.id, name: j.name, conclusion: j.conclusion, runAttempt: j.run_attempt,
        startedAt: j.started_at, completedAt: j.completed_at })),
      signedBuildOrigin: { attempt: 1, jobId: signed.id, execution: sha256(Buffer.from(executionIdentity(signed, "fixture").key)) },
      artifact: { id: 77, name: `relayium-macos-signed-${w.S}-ci`, digest: `sha256:${"e".repeat(64)}`, sizeInBytes: 10,
        createdAt: "2026-10-05T10:10:00Z", expiresAt: "2026-10-12T10:10:00Z" },
      files: { "Relayium.dmg": "c".repeat(64), "Relayium.dmg.sha256": "1".repeat(64), "provenance.json": "2".repeat(64),
        "release-tools/generate_appcast": "d".repeat(64) },
      version: VERSION, build: "43",
      toolchain: { xcode: "Xcode 16.4", swift: "Swift 6.1.2", macos: "15.7.9", runnerImage: "macos15/1" },
      coverage: { mode: "executed" },
      ...state.evidenceOver,
    };
    const decision = { decidedAt: "2026-10-05T11:20:10.123Z", mode: "auto", source: "reuse", reason: "run 321 attempt 1", evidence };
    state.decisionZip = zipOf([{ name: "reuse-decision.json", data: `${JSON.stringify(decision, null, 2)}\n` }]);
  }
  state.decisionArtifact = state.decisionArtifact === undefined ? {
    id: DECISION_ID, name: `relayium-macos-build-source-${w.S}-attempt-1`, digest: `sha256:${sha256(state.decisionZip)}`, expired: false,
    size_in_bytes: state.decisionZip.length, created_at: "2026-10-05T11:20:34Z", expires_at: "2027-01-03T11:20:00Z",
    workflow_run: { id: PUB_RUN, head_sha: w.S, repository_id: REPO_ID, head_repository_id: REPO_ID, head_branch: "main" },
  } : state.decisionArtifact;
  const job = (id, name, [status, conclusion], extra = {}) => ({
    id, name, status, conclusion, run_id: PUB_RUN, head_sha: w.S, run_attempt: 1,
    ...executed("2026-10-05T11:20:00Z", "2026-10-05T11:21:00Z", ["ubuntu-latest"]), ...extra });
  // The preflight as the real one runs: its decision is made inside the
  // Select step and uploaded inside the Upload step that follows it.
  const preflight = () => job(1, "preflight", ["completed", "success"], { steps: [
    { number: 1, name: "Set up job", status: "completed", conclusion: "success", started_at: "2026-10-05T11:20:00Z", completed_at: "2026-10-05T11:20:01Z" },
    { number: 4, name: "Select the signed-build source", status: "completed", conclusion: "success", started_at: "2026-10-05T11:20:05Z", completed_at: "2026-10-05T11:20:30Z" },
    { number: 5, name: "Upload the signed-build source decision", status: "completed", conclusion: "success", started_at: "2026-10-05T11:20:31Z", completed_at: "2026-10-05T11:20:35Z" },
    { number: 11, name: "Complete job", status: "completed", conclusion: "success", started_at: "2026-10-05T11:20:59Z", completed_at: "2026-10-05T11:21:00Z" },
  ], ...state.preflightOver });
  const publisherJobs = () => [
    preflight(),
    ...(state.freshBuild ? state.buildJobs : [job(2, "build", ["completed", "skipped"])]),
    job(3, "notarize-stage", state.notarizeJob, executed("2026-10-05T11:30:00Z", "2026-10-05T11:41:00Z", ["macos-15"])),
    job(4, "publish", state.publishJob),
  ];
  const list = (key, items) => ({ total_count: items.length, [key]: items });
  const routes = (path) => {
    const p = path.replace(/[?&]per_page=100&page=1$/, "");
    if (p === `/repos/${REPO}`) return { id: REPO_ID, full_name: REPO };
    if (p === `/repos/${REPO}/git/ref/heads/main`) return { object: { sha: state.main, type: "commit" } };
    if (p === `/repos/${REPO}/git/ref/heads/${branchName}`) return state.branch ? { object: { sha: state.branch, type: "commit" } } : null;
    let m = /^\/repos\/[^/]+\/[^/]+\/git\/commits\/([0-9a-f]{40})$/.exec(p);
    if (m) {
      const parents = git(w.dir, "rev-list", "--parents", "-n", "1", m[1]).split(" ").slice(1);
      return { sha: m[1], tree: { sha: git(w.dir, "rev-parse", `${m[1]}^{tree}`) }, parents: parents.map((sha) => ({ sha })) };
    }
    m = /^\/repos\/[^/]+\/[^/]+\/git\/trees\/([0-9a-f]{40})$/.exec(p);
    if (m) {
      const tree = git(w.dir, "ls-tree", m[1]).split("\n").filter(Boolean).map((line) => {
        const [meta, name] = line.split("\t");
        const [, type, sha] = meta.split(" ");
        return { path: name, type, sha };
      });
      return { sha: m[1], tree, truncated: state.truncated ?? false };
    }
    // `macos.yml` at an immutable commit, from the real Git objects (or a world's override).
    m = /^\/repos\/[^/]+\/[^/]+\/contents\/\.github\/workflows\/macos\.yml\?ref=([0-9a-f]{40})$/.exec(path);
    if (m) {
      if (state.producerWorkflow === null) return null;
      if (state.producerWorkflowRaw) return state.producerWorkflowRaw;
      const text = state.producerWorkflow ?? git(w.dir, "show", `${m[1]}:.github/workflows/macos.yml`) + "\n";
      return { path: ".github/workflows/macos.yml", encoding: "base64", content: Buffer.from(text).toString("base64"), sha: "f".repeat(40) };
    }
    if (p === `/repos/${REPO}/actions/artifacts/${ART_ID}`) return state.artifact;
    if (p === `/repos/${REPO}/actions/artifacts/${DECISION_ID}`) return state.decisionArtifact;
    if (p === `/repos/${REPO}/actions/runs/${PUB_RUN}/artifacts`) {
      return list("artifacts", [state.artifact, ...(state.decisionArtifact ? [state.decisionArtifact] : [])]);
    }
    if (p === `/repos/${REPO}/actions/runs/${PUB_RUN}`) {
      return { id: PUB_RUN, run_attempt: state.publisherAttempt, head_sha: w.S, head_branch: "main", event: "workflow_dispatch",
        path: ".github/workflows/macos-release.yml", status: state.publisherStatus[0], conclusion: state.publisherStatus[1], ...ids };
    }
    if (p === `/repos/${REPO}/actions/runs/${PUB_RUN}/attempts/${state.publisherAttempt}/jobs`) {
      return list("jobs", state.publisherJobsOver ? state.publisherJobsOver(publisherJobs()) : publisherJobs());
    }
    // Earlier attempts a world records: { [n]: { run, jobs } } per run id.
    m = /^\/repos\/[^/]+\/[^/]+\/actions\/runs\/(\d+)\/attempts\/(\d+)(\/jobs)?$/.exec(p);
    const past = m ? state.history?.[m[1]]?.[m[2]] : undefined;
    if (past) return m[3] ? list("jobs", past.jobs) : past.run;
    if (p === `/repos/${REPO}/actions/runs/321`) {
      return { id: 321, run_attempt: state.producerAttempt, head_sha: w.S, head_branch: "main", event: "push",
        path: ".github/workflows/macos.yml", status: "completed", conclusion: "success", ...ids };
    }
    if (p === `/repos/${REPO}/actions/runs/321/attempts/${state.producerAttempt}`) {
      return { id: 321, run_attempt: state.producerAttempt, head_sha: w.S, status: "completed", conclusion: "success" };
    }
    if (p === `/repos/${REPO}/actions/runs/321/attempts/${state.producerAttempt}/jobs`) return list("jobs", state.producerJobs);
    if (p === `/repos/${REPO}/actions/workflows/merge-gate.yml`) return { id: 9, path: ".github/workflows/merge-gate.yml", state: "active" };
    if (p.startsWith(`/repos/${REPO}/actions/workflows/9/runs`)) return list("workflow_runs", [gateRun()]);
    if (p === `/repos/${REPO}/actions/runs/${GATE_RUN}`) return gateRun();
    if (p === `/repos/${REPO}/actions/runs/${GATE_RUN}/attempts/${state.gateAttempt}/jobs`) {
      return list("jobs", state.gateJobs.map(([name, conclusion, extra], i) => ({
        id: i + 1, name, status: "completed", conclusion, run_id: GATE_RUN, head_sha: w.C, run_attempt: state.gateAttempt, ...extra })));
    }
    if (p.startsWith(`/repos/${REPO}/commits/`) && p.includes("/check-runs")) return list("check_runs", state.checkRuns);
    if (p === `/repos/${REPO}/git/ref/tags/macos-v${VERSION}`) return state.tag;
    if (p === `/repos/${REPO}/releases/tags/macos-v${VERSION}`) {
      return state.releases.find((r) => r.tag_name === `macos-v${VERSION}` && !r.draft) ?? null;
    }
    m = /^\/repos\/[^/]+\/[^/]+\/releases\?per_page=100&page=(\d+)$/.exec(path);
    if (m) return state.releasePages ? state.releasePages(Number(m[1])) : (m[1] === "1" ? state.releases : []);
    m = /^\/repos\/[^/]+\/[^/]+\/releases\/(\d+)$/.exec(p);
    if (m) return state.releaseById[m[1]] ?? null;
    if (p === `/repos/${REPO}/releases/latest`) return state.latest;
    const error = new Error(`fake: no route for ${path}`);
    error.status = 404;
    throw error;
  };
  const notFound = () => { const e = new Error("404"); e.status = 404; return e; };
  return {
    state, branchName,
    api: {
      async get(path) { const v = routes(path); if (v === null) throw notFound(); return v; },
      async getOptional(path) { return routes(path); },
      async download(path, { accept } = {}) {
        if (path === `/repos/${REPO}/actions/artifacts/${ART_ID}/zip`) return state.zipOverride ?? w.zip;
        if (path === `/repos/${REPO}/actions/artifacts/${DECISION_ID}/zip`) return state.decisionZip;
        const m = /\/releases\/assets\/(\d+)$/.exec(path);
        if (m && accept === "application/octet-stream" && state.assetBytes[m[1]]) return state.assetBytes[m[1]];
        throw notFound();
      },
    },
  };
}

const ENV = (w) => ({
  GITHUB_REPOSITORY: REPO, GITHUB_REPOSITORY_ID: String(REPO_ID), GITHUB_RUN_ID: String(PUB_RUN),
  GITHUB_RUN_ATTEMPT: "1", RELEASE_VERSION: VERSION, GITHUB_SHA: w.S,
});

/** The same record as a pre-v2 handoff would have carried it: v1, no signedBuild. */
export function asV1(rec) {
  const { signedBuild, ...rest } = rec;
  return parseHandoff(JSON.stringify({ ...rest, schema: HANDOFF_SCHEMA_V1 }));
}

/** Emit as the live publish job does: the publish job is still in progress. */
export async function emitFor(w, fake, { candidate = w.C } = {}) {
  const saved = [fake.state.publishJob, fake.state.publisherStatus];
  fake.state.publishJob = ["in_progress", null];
  fake.state.publisherStatus = ["in_progress", null];
  try {
    return await emitHandoff(fake.api, ENV(w), {
      cwd: w.dir, artifactDir: w.art, candidate, branch: fake.branchName, dispatchedAt: "2026-10-05T11:58:00Z", now: NOW,
    });
  } finally {
    [fake.state.publishJob, fake.state.publisherStatus] = saved;
  }
}

/** A published release whose assets are the given bytes. */
function publishRelease(fake, rec, bytes) {
  const assets = [["Relayium.dmg", 1], ["Relayium.dmg.sha256", 2], ["appcast.xml", 3]].map(([name, id]) => ({
    id, name, state: "uploaded", size: bytes[name].length }));
  const release = { id: 81, tag_name: rec.release.tag, draft: false, prerelease: false,
    name: rec.releasePlan.title, body: rec.releasePlan.notes, assets };
  fake.state.releases = [release];
  fake.state.releaseById = { 81: release };
  fake.state.assetBytes = { 1: bytes["Relayium.dmg"], 2: bytes["Relayium.dmg.sha256"], 3: bytes["appcast.xml"] };
  return release;
}

export async function run() {
  const failures = [];
  let passed = 0;
  const cleanup = [];
  async function expect(label, fn, reason) {
    try {
      await fn();
      if (reason) failures.push(`${label}: accepted, want refusal matching ${reason}`);
      else passed += 1;
    } catch (error) {
      if (!reason) failures.push(`${label}: refused (${error.message}), want acceptance`);
      else if (!(error instanceof Refused)) failures.push(`${label}: threw a non-Refused ${error.constructor.name}: ${error.message}`);
      else if (!reason.test(error.message)) failures.push(`${label}: refused for the wrong reason: ${error.message}`);
      else passed += 1;
    }
  }
  const fresh = (opts, over) => { const w = world(opts); cleanup.push(w.dir, w.art); return { w, fake: fakeApi(w, over) }; };
  const vo = (w, extra = {}) => ({ cwd: w.dir, artifactDir: w.art, now: NOW, ...extra });
  const V = (fake, rec, w, stage, extra) => verifyHandoff(fake.api, rec, { stage, ...vo(w, extra) });

  try {
    // ── emit + strict schema ──
    {
      const { w, fake } = fresh();
      const rec = await emitFor(w, fake);
      await expect("positive: emitted record round-trips", () => parseHandoff(JSON.stringify(rec)));
      await expect("emitted record binds the gate run, artifact and candidate", () => {
        if (rec.gate.runId !== GATE_RUN || rec.gate.attempt !== 1) throw new Error("gate not bound");
        if (rec.candidate.base !== w.M || rec.candidate.head !== w.C) throw new Error("candidate not bound");
        if (rec.artifact.digest !== `sha256:${sha256(w.zip)}` || rec.release.build !== 43) throw new Error("artifact not bound");
        if (rec.releasePlan.latest !== false || rec.releasePlan.target !== w.S) throw new Error("plan wrong");
        if (rec.releasePlan.notes !== releaseNotes(PUB_RUN)) throw new Error("notes wrong");
      });
      const summary = handoffSummary(rec);
      await expect("summary says HANDED OFF / NOT PUBLISHED and never claims publication", () => {
        if (!summary.includes("HANDED OFF / NOT PUBLISHED")) throw new Error("no banner");
        if (!/did NOT create a GitHub Release/.test(summary)) throw new Error("claims publication");
      });
      const catalog = join(w.art, "server/account/macos_release_catalog.json");
      const catalogBytes = readFileSync(catalog);
      writeFileSync(catalog, "not the committed catalog");
      await expect("emit refuses a local artifact copy that is not the authenticated archive", () => emitFor(w, fake), /local server\/account\/macos_release_catalog.json is not the authenticated/);
      writeFileSync(catalog, catalogBytes);
      fake.state.artifact = { ...fake.state.artifact, expired: true };
      await expect("emit refuses an expired artifact", () => emitFor(w, fake), /expired/);
      fake.state.artifact = { ...fake.state.artifact, expired: false };
      fake.state.zipOverride = Buffer.concat([w.zip, Buffer.from("x")]);
      await expect("emit refuses a downloaded archive that does not hash to the API digest", () => emitFor(w, fake), /not the API digest/);
      fake.state.zipOverride = null;
      fake.state.notarizeJob = ["completed", "failure"];
      await expect("emit refuses when notarize-stage did not succeed", () => emitFor(w, fake), /notarize-stage is completed\/failure/);
      fake.state.notarizeJob = ["completed", "success"];
      fake.state.artifact = { ...fake.state.artifact, created_at: "2026-10-05T11:00:00Z" };
      await expect("emit refuses an artifact created outside notarize-stage", () => emitFor(w, fake), /outside notarize-stage/);
      fake.state.artifact = { ...fake.state.artifact, created_at: "2026-10-05T11:40:00Z" };
      await expect("emit refuses when no gate run was dispatched", () => {
        fake.state.publishJob = ["in_progress", null];
        return emitHandoff(fake.api, ENV(w), {
          cwd: w.dir, artifactDir: w.art, candidate: w.C, branch: "release-candidate/other", dispatchedAt: "2026-10-05T11:58:00Z", now: NOW,
        }).finally(() => { fake.state.publishJob = ["completed", "success"]; });
      }, /no merge-gate run/);
      const mutate = (fn) => { const r = JSON.parse(JSON.stringify(rec)); fn(r); return JSON.stringify(r); };
      await expect("malformed: not JSON", () => parseHandoff("{"), /not JSON/);
      await expect("malformed: extra key", () => parseHandoff(mutate((r) => { r.extra = 1; })), /schema requires exactly/);
      await expect("malformed: missing key", () => parseHandoff(mutate((r) => { delete r.gate; })), /schema requires exactly/);
      await expect("malformed: nested extra", () => parseHandoff(mutate((r) => { r.artifact.url = "x"; })), /artifact has keys/);
      await expect("malformed: wrong type", () => parseHandoff(mutate((r) => { r.release.build = "43"; })), /release.build is not integer/);
      await expect("malformed: wrong schema", () => parseHandoff(mutate((r) => { r.schema = "v0"; })), /schema/);
      await expect("malformed: latest=true", () => parseHandoff(mutate((r) => { r.releasePlan.latest = true; })), /latest must be false/);
      await expect("malformed: target not source", () => parseHandoff(mutate((r) => { r.releasePlan.target = w.M; })), /target is not the notarized source/);
      await expect("malformed: artifact from another run", () => parseHandoff(mutate((r) => { r.artifact.workflowRunId = 1; })), /not the publisher run/);
      await expect("malformed: branch not bound to run", () => parseHandoff(mutate((r) => { r.candidate.branch = "release-candidate/x"; })), /branch does not bind/);
      await expect("malformed: frozen without gate", () => parseHandoff(mutate((r) => { r.gate.runId = null; })), /no identified gate/);
      await expect("malformed: derived set wrong", () => parseHandoff(mutate((r) => { delete r.derived["web/native-releases.json"]; })), /five derived files/);
      await expect("malformed: x86 architecture", () => parseHandoff(mutate((r) => { r.release.architectures = ["arm64", "x86_64"]; })), /arm64/);

      // ── verify stage=main ──
      await expect("positive: verify main", () => V(fake, rec, w, "main"));
      await expect("unknown stage", () => V(fake, rec, w, "publish"), /stage "publish"/);

      // The root's control: a substituted unsigned local DMG with matching
      // checksum, provenance and record hash, while the API artifact is unchanged.
      {
        const forged = Buffer.from("UNRELATED UNSIGNED SUBSTITUTE DMG");
        const fsha = sha256(forged);
        const saved = new Map([...w.files].map(([k, v]) => [k, v]));
        writeFileSync(join(w.art, "Relayium.dmg"), forged);
        writeFileSync(join(w.art, "Relayium.dmg.sha256"), `${fsha}  Relayium.dmg\n`);
        const prov = JSON.parse(readFileSync(join(w.art, "provenance.json"), "utf8"));
        prov.dmgSha256 = fsha;
        writeFileSync(join(w.art, "provenance.json"), JSON.stringify(prov));
        const forgedRec = parseHandoff(mutate((r) => { r.dmg.sha256 = fsha; }));
        await expect("substituted local DMG + forged record (API unchanged)", () => V(fake, forgedRec, w, "main"), /authenticated artifact's DMG is not the handed-off DMG/);
        await expect("substituted local DMG with the original record", () => V(fake, rec, w, "main"), /local Relayium.dmg is not the authenticated/);
        // The same substitution supplied as an explicit archive: refused on digest.
        const forgedZip = join(w.art, "..", `${w.dir.split("/").pop()}-forged.zip`);
        cleanup.push(forgedZip);
        const forgedFiles = new Map(saved);
        forgedFiles.set("Relayium.dmg", forged);
        writeFileSync(forgedZip, zipOf([...forgedFiles].map(([name, data]) => ({ name, data }))));
        await expect("explicit substitute archive", () => V(fake, rec, w, "main", { archive: forgedZip }), /not the API digest/);
        installArtifact(w, saved);
        const goodZip = `${forgedZip}.good`;
        cleanup.push(goodZip);
        writeFileSync(goodZip, w.zip);
        await expect("positive: explicit authentic archive", () => V(fake, rec, w, "main", { archive: goodZip }));
      }

      // Malformed archives that still hash to the (fake) API digest: the
      // archive is judged on its entries, not only on its hash.
      {
        const bad = async (label, entries, reason) => {
          const zip = zipOf(entries);
          fake.state.zipOverride = zip;
          fake.state.artifact = { ...fake.state.artifact, digest: `sha256:${sha256(zip)}` };
          const r = parseHandoff(mutate((x) => { x.artifact.digest = `sha256:${sha256(zip)}`; }));
          await expect(label, () => V(fake, r, w, "main"), reason);
        };
        const good = [...w.files].map(([name, data]) => ({ name, data }));
        await bad("archive: duplicate entry", [...good, good[0]], /names Relayium.dmg twice/);
        await bad("archive: extra file", [...good, { name: "evil.sh", data: "x" }], /unexpected evil.sh/);
        await bad("archive: missing file", good.slice(1), /lacks Relayium.dmg/);
        await bad("archive: traversal name", [...good.slice(1), { name: "../Relayium.dmg", data: "x" }], /traversal/);
        await bad("archive: symlink entry", [{ ...good[0], mode: 0o120777 }, ...good.slice(1)], /symlink/);
        await bad("archive: CRC mismatch", [{ ...good[0], crc: 1 }, ...good.slice(1)], /CRC|crc/);
        await bad("archive: unexpected directory", [{ name: "other/", data: "", mode: 0o040755 }, ...good], /unexpected directory other\//);
        await bad("archive: provenance with an extra key", good.map((e) => (e.name === "provenance.json"
          ? { ...e, data: JSON.stringify({ ...JSON.parse(e.data), extra: 1 }) } : e)), /provenance has keys/);
        await bad("archive: provenance not notarized by this run", good.map((e) => (e.name === "provenance.json"
          ? { ...e, data: JSON.stringify({ ...JSON.parse(e.data), notarizedBy: { runId: "1", runAttempt: "1", signedBuildSource: "reuse" } }) } : e)), /notarizedBy names run 1/);
        await bad("archive: provenance for another source", good.map((e) => (e.name === "provenance.json"
          ? { ...e, data: JSON.stringify({ ...JSON.parse(e.data), sha: w.M }) } : e)), /provenance.sha/);
        await bad("archive: Intel provenance", good.map((e) => (e.name === "provenance.json"
          ? { ...e, data: JSON.stringify({ ...JSON.parse(e.data), arch: "x86_64 arm64" }) } : e)), /provenance.arch/);
        fake.state.zipOverride = Buffer.from("not a zip at all, but hashed");
        fake.state.artifact = { ...fake.state.artifact, digest: `sha256:${sha256(fake.state.zipOverride)}` };
        await expect("archive: not a zip", () => V(fake, parseHandoff(mutate((x) => { x.artifact.digest = fake.state.artifact.digest; })), w, "main"), /end-of-central-directory|too short/);
        fake.state.zipOverride = null;
        fake.state.artifact = { ...fake.state.artifact, digest: rec.artifact.digest };
      }

      fake.state.main = w.S;
      await expect("moved main", () => V(fake, rec, w, "main"), /not the candidate base/);
      fake.state.main = w.M;
      fake.state.branch = w.M;
      await expect("moved branch", () => V(fake, rec, w, "main"), /release-candidate\/.* is .*not/);
      fake.state.branch = w.C;
      fake.state.gateAttempt = 2;
      await expect("gate rerun since handoff", () => V(fake, rec, w, "main"), /now attempt 2, not 1/);
      fake.state.gateAttempt = 1;
      const honest = fake.state.gateJobs;
      fake.state.gateJobs = honest.map(([n, c]) => (n === "compat / wire-vectors" ? [n, "failure"] : [n, c]));
      await expect("failed gate job under green aggregate", () => V(fake, rec, w, "main"), /job compat \/ wire-vectors concluded failure/);
      fake.state.gateJobs = [["select", "success"], ["go", "success"], ["merge-gate", "success"]];
      await expect("fabricated three-job gate list", () => V(fake, rec, w, "main"), /lacks required job|outside the base-owned roster/);
      // The root's r2 gap: every inner web job removed, one auxiliary-named success left.
      fake.state.gateJobs = honest.filter(([n]) => !n.startsWith("web / ")).concat([["web / auxiliary-only", "success"]]);
      await expect("selected web lane with only an auxiliary-named success", () => V(fake, rec, w, "main"), /"web \/ auxiliary-only" outside the base-owned roster/);
      fake.state.gateJobs = honest.filter(([n]) => !n.startsWith("web / ") || /evidence|screen|certify/.test(n));
      await expect("selected web lane with only its auxiliaries", () => V(fake, rec, w, "main"), /lacks required job\(s\) web \/ scope, web \/ test/);
      fake.state.gateJobs = honest.map(([n, c]) => (n === "web / test" || n === "web / sealed-box-interop" ? [n, "skipped"] : [n, c]));
      await expect("required web jobs skipped", () => V(fake, rec, w, "main"), /job "web \/ test" concluded skipped; the base roster requires success/);
      fake.state.gateJobs = honest.map(([n, c]) => (n === "web / test" ? ["web", "skipped"] : [n, c]));
      await expect("selected lane reported as a skipped caller", () => V(fake, rec, w, "main"), /outside the base-owned roster/);
      const unselected = honest.find(([n, c]) => c === "skipped" && !n.includes(" / "))[0];
      fake.state.gateJobs = honest.filter(([n]) => n !== unselected);
      await expect("unselected lane absent from the graph", () => V(fake, rec, w, "main"), new RegExp(`lacks required job\\(s\\) ${unselected}`));
      fake.state.gateJobs = [...honest, ["deploy / prod", "success"]];
      await expect("stray job in the gate graph", () => V(fake, rec, w, "main"), /outside the base-owned roster/);
      fake.state.gateJobs = [...honest, ["web / test", "success"]];
      await expect("duplicate required job", () => V(fake, rec, w, "main"), /lists "web \/ test" more than once/);
      fake.state.gateJobs = honest.map(([n, c]) => (n === "web / evidence" ? [n, "skipped"] : n === "web / screen" ? null : [n, c])).filter(Boolean);
      await expect("positive: auxiliary evidence skipped and a main-only screen absent", () => V(fake, rec, w, "main"));
      fake.state.gateJobs = honest.map(([n, c]) => (n === "web / screen" ? [n, "success"] : [n, c]));
      await expect("main-only auxiliary that ran in a dispatched gate", () => V(fake, rec, w, "main"), /"web \/ screen" concluded success; the base roster requires skipped/);
      fake.state.gateJobs = honest.map(([n, c]) => (n === "web / test" ? [n, c, { run_attempt: 2 }] : [n, c]));
      await expect("gate job from a later attempt than the judged one", () => V(fake, rec, w, "main"), /not a completed job of this run at attempt <= 1/);
      fake.state.gateJobs = honest;
      fake.state.artifact = { ...fake.state.artifact, expired: true };
      await expect("expired artifact", () => V(fake, rec, w, "main"), /expired/);
      fake.state.artifact = { ...fake.state.artifact, expired: false, digest: `sha256:${"b".repeat(64)}` };
      await expect("artifact digest changed", () => V(fake, rec, w, "main"), /digest/);
      fake.state.artifact = { ...fake.state.artifact, digest: rec.artifact.digest, workflow_run: { ...fake.state.artifact.workflow_run, head_sha: w.M } };
      await expect("artifact from another source", () => V(fake, rec, w, "main"), /does not belong to publisher run/);
      fake.state.artifact = { ...fake.state.artifact, workflow_run: { ...fake.state.artifact.workflow_run, head_sha: w.S } };
      fake.state.publisherAttempt = 2;
      await expect("publisher rerun", () => V(fake, rec, w, "main"), /publisher run is now attempt 2/);
      fake.state.publisherAttempt = 1;
      fake.state.publisherStatus = ["completed", "failure"];
      await expect("publisher run not successful at verify", () => V(fake, rec, w, "main"), /completed\/failure; the handoff exists only after/);
      fake.state.publisherStatus = ["completed", "success"];
      const appcast = join(w.art, "release-web/public/apps/macos/appcast.xml");
      const appcastBytes = readFileSync(appcast);
      writeFileSync(appcast, "wrong derived");
      await expect("wrong local derived bytes", () => V(fake, rec, w, "main"), /local release-web\/public\/apps\/macos\/appcast.xml is not the authenticated/);
      writeFileSync(appcast, appcastBytes);
      const forgedParent = { ...rec, candidate: { ...rec.candidate, base: w.S } };
      await expect("wrong parent", () => V(fake, forgedParent, w, "main"), /parents/);
      const fewer = { ...rec, candidate: { ...rec.candidate, changedPaths: rec.candidate.changedPaths.slice(1) } };
      await expect("changed paths differ from record", () => V(fake, fewer, w, "main"), /changed paths are not the recorded/);
      const wrongHash = { ...rec, derived: { ...rec.derived, "web/native-client-policy.json": "0".repeat(64) } };
      await expect("record claims other derived bytes", () => V(fake, wrongHash, w, "main"), /native-client-policy.json is not the handed-off/);
      // main moves DURING verification: the end recheck refuses.
      {
        const inner = fake.api.get;
        let reads = 0;
        fake.api.get = async (path) => {
          if (path === `/repos/${REPO}/git/ref/heads/main` && (reads += 1) > 1) return { object: { sha: w.S, type: "commit" } };
          return inner(path);
        };
        await expect("main moved during verification", () => V(fake, rec, w, "main"), /main moved while|not an ancestor|not the candidate base/);
        fake.api.get = inner;
      }

      // ── verify stage=release ──
      await expect("release before main carries the candidate", () => V(fake, rec, w, "release"), /not the delivered candidate/);
      git(w.dir, "update-ref", "refs/heads/delivered", w.C);
      fake.state.main = w.C;
      await expect("positive: verify release (tag absent)", () => V(fake, rec, w, "release"));
      write(w.dir, "docs/later.md", "x\n");
      git(w.dir, "checkout", "-q", "--detach", w.C);
      const later = commit(w.dir, "later main");
      fake.state.main = later;
      await expect("release when main moved past the candidate", () => V(fake, rec, w, "release"), /not the delivered candidate/);
      fake.state.main = w.C;
      fake.state.tag = { object: { sha: w.M, type: "commit" } };
      await expect("existing tag at the wrong commit", () => V(fake, rec, w, "release"), /already targets/);
      fake.state.tag = { object: { sha: w.S, type: "commit" } };
      const bytes = { "Relayium.dmg": w.files.get("Relayium.dmg"), "Relayium.dmg.sha256": w.files.get("Relayium.dmg.sha256"),
        "appcast.xml": w.files.get("release-web/public/apps/macos/appcast.xml") };
      const release = publishRelease(fake, rec, bytes);
      await expect("positive: existing identical release (authenticated asset downloads)", () => V(fake, rec, w, "release"));
      fake.state.latest = { tag_name: rec.release.tag };
      await expect("existing release is the latest alias", () => V(fake, rec, w, "release"), /latest release/);
      fake.state.latest = null;
      fake.state.assetBytes = { ...fake.state.assetBytes, 1: Buffer.from("rebuilt dmg bytes, same lengthXX").subarray(0, bytes["Relayium.dmg"].length) };
      await expect("existing release with different DMG bytes", () => V(fake, rec, w, "release"), /asset Relayium.dmg is not the notarized original/);
      fake.state.assetBytes = { ...fake.state.assetBytes, 1: bytes["Relayium.dmg"] };
      release.name = "Relayium 1.4.6";
      await expect("existing release with another title", () => V(fake, rec, w, "release"), /is titled/);
      release.name = rec.releasePlan.title;
      release.assets = [...release.assets, { id: 9, name: "extra.zip", state: "uploaded", size: 1 }];
      await expect("existing release with an extra asset", () => V(fake, rec, w, "release"), /not exactly/);
      release.assets = release.assets.slice(0, 3);
      release.draft = true;
      await expect("existing draft release", () => V(fake, rec, w, "release"), /draft or prerelease/);
      release.draft = false;
      // A draft hidden on page two of a full first page.
      const filler = Array.from({ length: 100 }, (_, i) => ({ id: 1000 + i, tag_name: `other-${i}`, draft: false, prerelease: false }));
      fake.state.releasePages = (page) => (page === 1 ? filler : page === 2 ? [{ ...release, id: 82, draft: true }] : []);
      fake.state.tag = null;
      fake.state.releases = [];
      await expect("draft hidden on page two", () => V(fake, rec, w, "release"), /draft or prerelease|tag is absent/);
      let flip = 0;
      fake.state.releasePages = (page) => (page === 1 ? ((flip += 1) === 1 ? [{ id: 1 }] : [{ id: 2 }]) : []);
      await expect("release list changes between complete reads", () => V(fake, rec, w, "release"), /changed between two complete reads/);
      fake.state.releasePages = null;
      publishRelease(fake, rec, bytes);
      await expect("release named but tag absent", () => V(fake, rec, w, "release"), /tag is absent/);
    }

    // ── base-owned scope: neither candidate nor invoking checkout can relax it ──
    {
      const { w, fake } = fresh({ candidateExtra: (dir) => {
        write(dir, "docs/evil.md", "smuggled\n");
        write(dir, "web/scripts/macos-release-candidate.mjs", PERMISSIVE_CHECKER);
      } });
      const rec = await emitFor(w, fake);
      // The invoking checkout carries the permissive checker too.
      git(w.dir, "checkout", "-q", "--detach", w.C);
      fake.state.gateJobs = gateJobsFor(w);
      await expect("candidate + checkout ship a permissive checker; base scope still refuses", () => V(fake, rec, w, "main"), /outside the base-owned release-metadata scope.*docs\/evil.md/);
      git(w.dir, "rm", "-q", "web/scripts/macos-release-candidate.mjs");
      const noChecker = commit(w.dir, "base without a checker");
      const { loadBaseJudges } = await import("../release/macos-handoff.mjs");
      await expect("unknown base checker", () => loadBaseJudges(noChecker, w.dir), /carries no web\/scripts\/macos-release-candidate.mjs/);
    }

    // ── native drift between source and candidate ──
    {
      const { w, fake } = fresh({ nativeDrift: true });
      const rec = await emitFor(w, fake);
      await expect("native input changed between source and candidate", () => V(fake, rec, w, "main"), /native inputs differ.*apps\/mac\/App.swift/);
      await expect("apps/README.md is not a native input", () => { if (isNativeInput("apps/README.md") || !isNativeInput("apps/mac/x")) throw new Error("classification"); });
    }

    // ── candidate empty (already delivered) still validates ──
    {
      const { w, fake } = fresh();
      fake.state.main = w.C;
      git(w.dir, "checkout", "-q", "--detach", w.C);
      const rec = await emitFor(w, fake, { candidate: "" });
      await expect("already-delivered record binds the main it found", () => {
        if (rec.candidate.state !== "already-delivered" || rec.candidate.base !== w.C || rec.gate.runId !== null) throw new Error("shape");
      });
      await expect("already-delivered cannot fast-forward", () => V(fake, rec, w, "main"), /nothing to fast-forward/);
      await expect("already-delivered without a delivering gate check", () => V(fake, rec, w, "release"), /carries no successful merge-gate check run/);
      const aggregateId = fake.state.gateJobs.findIndex(([n]) => n === "merge-gate") + 1;
      const check = (over = {}) => ({ id: aggregateId, name: "merge-gate", head_sha: w.C, app: { id: 15368 }, status: "completed",
        conclusion: "success", check_suite: { id: 5005 },
        details_url: `https://github.com/${REPO}/actions/runs/${GATE_RUN}/job/${aggregateId}`, ...over });
      fake.state.checkRuns = [check({ app: { id: 99 } })];
      await expect("already-delivered gate check from another app", () => V(fake, rec, w, "release"), /no successful merge-gate check run/);
      fake.state.checkRuns = [check()];
      await expect("positive: already-delivered release verify re-checks bytes and the authenticated parent gate", () => V(fake, rec, w, "release"));
      // The root's r2 gap: a details_url naming an unrelated failed run.
      {
        const inner = fake.api.get;
        fake.api.get = async (path) => (path === `/repos/${REPO}/actions/runs/888`
          ? { id: 888, path: ".github/workflows/unrelated.yml", status: "completed", conclusion: "failure", run_attempt: 1 } : inner(path));
        fake.state.checkRuns = [check({ details_url: `https://github.com/${REPO}/actions/runs/888/job/${aggregateId}` })];
        await expect("delivered check whose details_url names an unrelated failed run", () => V(fake, rec, w, "release"), /run 888 is not a dispatched merge-gate.yml run/);
        fake.api.get = inner;
      }
      fake.state.checkRuns = [check()];
      const parentCase = async (label, over, reason) => {
        fake.state.gateRunOver = over;
        await expect(label, () => V(fake, rec, w, "release"), reason);
        fake.state.gateRunOver = {};
      };
      await parentCase("delivered parent from another workflow", { path: ".github/workflows/web.yml" }, /not a dispatched merge-gate.yml run/);
      await parentCase("delivered parent still queued", { status: "queued", conclusion: null }, /is queued\/null/);
      await parentCase("delivered parent failed", { conclusion: "failure" }, /is completed\/failure/);
      await parentCase("delivered parent in another check suite", { check_suite_id: 6006 }, /not in run 777's check suite/);
      await parentCase("delivered parent on a branch of another version", { head_branch: "release-candidate/macos-v9.9.9-1-1" }, /neither a frozen macos-v1.4.6 candidate/);
      fake.state.checkRuns = [check({ id: 4242, details_url: `https://github.com/${REPO}/actions/runs/${GATE_RUN}/job/4242` })];
      await expect("delivered check run that is not the latest attempt's aggregate job", () => V(fake, rec, w, "release"), /not the aggregate job of run 777's latest attempt 1/);
      fake.state.checkRuns = [check({ details_url: `https://github.com/${REPO}/actions/runs/${GATE_RUN}/job/1` })];
      await expect("delivered check run whose details_url names another job", () => V(fake, rec, w, "release"), /does not name a job of this repository with its own id/);
      fake.state.checkRuns = [check()];
      const honest = fake.state.gateJobs;
      fake.state.gateJobs = honest.filter(([n]) => !n.startsWith("web / test"));
      const shifted = fake.state.gateJobs.findIndex(([n]) => n === "merge-gate") + 1;
      fake.state.checkRuns = [check({ id: shifted, details_url: `https://github.com/${REPO}/actions/runs/${GATE_RUN}/job/${shifted}` })];
      await expect("delivered parent gate missing a required job", () => V(fake, rec, w, "release"), /lacks required job\(s\) web \/ test/);
      fake.state.gateJobs = honest;
      fake.state.checkRuns = [check()];
      fake.state.main = w.M;
      await expect("already-delivered but main is not the recorded main", () => V(fake, rec, w, "release"), /not the main .* this already-delivered record/);
      const bogus = parseHandoff(JSON.stringify({ ...rec, candidate: { ...rec.candidate, base: w.M } }));
      await expect("bogus already-delivered record on a main without the metadata", () => V(fake, bogus, w, "release"), /is not the authenticated artifact's|delivering commit .* has|no merge-gate check run/);
      fake.state.main = w.C;
      fake.state.artifact = { ...fake.state.artifact, expired: true };
      await expect("already-delivered with expired artifact", () => V(fake, rec, w, "release"), /expired/);
      fake.state.artifact = { ...fake.state.artifact, expired: false };
      // Later docs-only commits on main: the delivering commit is still C, its base M.
      write(w.dir, "docs/after.md", "after\n");
      const later = commit(w.dir, "docs after delivery");
      fake.state.main = later;
      const laterRec = await emitFor(w, fake, { candidate: "" });
      await expect("positive: already-delivered with later docs commits on main", () => V(fake, laterRec, w, "release"));
    }

    // ── the BASE-derived gate roster, on authentic names: Mac UI shards, Go account matrix, web ──
    {
      const { w } = fresh();
      const judges = await loadBaseJudges(w.M, w.dir);
      try {
        const head = w.C;
        const lanes = new Set(["macos", "go", "web"]);
        const G = (jobs, attempt = 1) => judgeGateLanes({
          get: async (path) => {
            if (!path.startsWith(`/repos/${REPO}/actions/runs/${GATE_RUN}/attempts/${attempt}/jobs`)) throw new Error(`no route ${path}`);
            return { total_count: jobs.length, jobs: jobs.map(([name, conclusion, extra], i) => ({
              id: i + 1, name, status: "completed", conclusion, run_id: GATE_RUN, head_sha: head, run_attempt: attempt, ...extra })) };
          },
        }, { repository: REPO, runId: GATE_RUN, attempt, head, expected: lanes, judges });
        const honest = honestGateJobs(lanes);
        await expect("roster fixture carries the real Mac UI shards and Go account matrix", () => {
          for (const n of [...MAC_UI, "go / race account shard 7", "macos / signed-build", "web / windows-temporary-downloader"]) {
            if (!honest.some(([x]) => x === n)) throw new Error(`fixture lacks ${n}`);
          }
        });
        await expect("positive: honest macos+go+web gate graph", () => G(honest));
        await expect("Mac UI shard absent", () => G(honest.filter(([n]) => n !== MAC_UI[1])), /lacks required job\(s\) macos \/ ui-smoke \(device-inbox/);
        await expect("Mac UI shard duplicated", () => G([...honest, [MAC_UI[0], "success"]]), /more than once/);
        await expect("Mac UI shard skipped", () => G(honest.map(([n, c]) => (n === MAC_UI[0] ? [n, "skipped"] : [n, c]))), /ui-smoke \(app-shell.* concluded skipped/);
        await expect("Mac UI matrix reported unexpanded", () => G(honest.filter(([n]) => !MAC_UI.includes(n)).concat([["macos / ui-smoke (${{ matrix.suite }})", "skipped"]])), /outside the base-owned roster/);
        await expect("Go account shard absent", () => G(honest.filter(([n]) => n !== "go / race account shard 3")), /lacks required job\(s\) go \/ race account shard 3/);
        await expect("Go account shard skipped", () => G(honest.map(([n, c]) => (n === "go / race account shard 5" ? [n, "skipped"] : [n, c]))), /shard 5" concluded skipped/);
        await expect("Go account shard renamed filler", () => G(honest.map(([n, c]) => (n === "go / race account shard 0" ? ["go / race account shard 8", c] : [n, c]))), /shard 8" outside the base-owned roster/);
        await expect("web required jobs absent with auxiliary success", () => G(honest.filter(([n]) => !n.startsWith("web / ") || n === "web / evidence")), /lacks required job\(s\) web \/ scope/);
        await expect("Mac signed-build skipped", () => G(honest.map(([n, c]) => (n === "macos / signed-build" ? [n, "skipped"] : [n, c]))), /signed-build" concluded skipped/);
        await expect("positive: a carried job from an earlier attempt in attempt 2", () => G(honest.map(([n, c]) => (n === "go / test" ? [n, c, { run_attempt: 1 }] : [n, c])), 2));
      } finally {
        judges.cleanup();
      }
      // Unknown predicates and unregistered jobs in BASE fail closed.
      const mutated = (file, edit) => {
        git(w.dir, "checkout", "-q", "--detach", w.M);
        const path = join(w.dir, ".github/workflows", file);
        writeFileSync(path, edit(readFileSync(path, "utf8")));
        return commit(w.dir, `mutate ${file}`);
      };
      const roster = async (base, lanesSel) => {
        const j = await loadBaseJudges(base, w.dir);
        try { return dispatchGateRoster(j, lanesSel); } finally { j.cleanup(); }
      };
      const unknownIf = mutated("web.yml", (t) => t.replace(/(\n {2}sealed-box-interop:\n(?: {4}.*\n)*? {4}if: )\$\{\{ !cancelled\(\) \}\}/, "$1${{ github.event_name == 'pull_request' }}"));
      await expect("unknown job predicate in a BASE lane workflow", () => roster(unknownIf, new Set(["web"])), /web.yml job sealed-box-interop has an unknown predicate/);
      const extraJob = mutated("go.yml", (t) => `${t.trimEnd()}\n  surprise:\n    runs-on: ubuntu-latest\n    steps:\n      - run: true\n`);
      await expect("BASE lane job the evidence registry does not know", () => roster(extraJob, new Set(["go"])), /go.yml job surprise is not in the evidence registry/);
      await expect("positive: unregistered job in an unselected lane is not judged", () => roster(extraJob, new Set(["web"])));
      const callerIf = mutated("merge-gate.yml", (t) => t.replace("if: needs.select.outputs['web'] == 'true'", "if: always()"));
      await expect("unknown lane-caller predicate in BASE merge-gate.yml", () => roster(callerIf, new Set(["web"])), /lane web has an unknown predicate/);
    }

    // ── canonical release notes ──
    {
      const { w, fake } = fresh();
      const rec = await emitFor(w, fake);
      await expect("positive: canonical notes", () => parseHandoff(JSON.stringify(rec)));
      await expect("notes-only change refused", () => parseHandoff(JSON.stringify({ ...rec, releasePlan: { ...rec.releasePlan, notes: "UNAUTHENTICATED INSTRUCTIONS" } })), /not the canonical notes of the publisher run/);
    }

    // ── reused producer: the signed-build job's own attempt ──
    {
      const { w, fake } = fresh();
      const rec = await emitFor(w, fake);
      const carried = fake.state.producerJobs;
      fake.state.producerAttempt = 4;
      fake.state.history = { 321: { 1: {
        run: { id: 321, run_attempt: 1, head_sha: w.S, path: ".github/workflows/macos.yml", status: "completed", conclusion: "failure" },
        jobs: carried.map((j) => ({ ...j })),
      } } };
      await expect("positive: signed-build carried from attempt 1 into latest attempt 4", () => V(fake, rec, w, "main"));
      // r3 refused this; it is what GitHub returns (run 36943045523, attempts 1 and 5).
      fake.state.producerJobs = carried.map((j) => (j.name === "signed-build"
        ? { ...j, id: 9304, node_id: "CR_relabelled", run_attempt: 4, created_at: "2026-10-05T12:00:00Z", runner_group_id: null } : j));
      await expect("positive: signed-build relabelled attempt 4 with a new id, same execution as attempt 1", () => V(fake, rec, w, "main"));
      fake.state.producerJobs = carried.map((j) => (j.name === "signed-build"
        ? { ...j, run_attempt: 4, started_at: "2026-10-05T12:00:00Z", completed_at: "2026-10-05T12:20:00Z" } : j));
      await expect("signed-build re-ran in attempt 4 (new times), provenance says 1", () => V(fake, rec, w, "main"), /different execution/);
      fake.state.producerJobs = carried.map((j) => (j.name === "signed-build"
        ? { ...j, run_attempt: 4, steps: j.steps.map((st) => (st.number === 2 ? { ...st, completed_at: "2026-10-05T10:19:00Z" } : st)) } : j));
      await expect("relabelled signed-build with one step changed", () => V(fake, rec, w, "main"), /different execution/);
      fake.state.producerJobs = carried;
      const hist = fake.state.history;
      fake.state.history = undefined;
      await expect("producer original attempt 1 unavailable", () => V(fake, rec, w, "main"), /attempt 1 could not be read/);
      fake.state.history = { 321: { 1: { ...hist[321][1], jobs: hist[321][1].jobs.map((j) => (j.name === "signed-build" ? { ...j, conclusion: "failure" } : j)) } } };
      await expect("producer original signed-build failed", () => V(fake, rec, w, "main"), /not a completed success/);
      fake.state.history = { 321: { 1: { ...hist[321][1], run: { ...hist[321][1].run, head_sha: w.C } } } };
      await expect("producer original attempt on another head", () => V(fake, rec, w, "main"), /not a completed attempt/);
      fake.state.history = hist;
      fake.state.producerJobs = carried.filter((j) => !j.name.startsWith("ui-smoke (device-inbox"));
      await expect("producer inventory missing a UI shard", () => V(fake, rec, w, "main"), /has 0 `ui-smoke\/device-inbox` job\(s\); want exactly one/);
      fake.state.producerJobs = [...carried, { ...carried[0], id: 399, name: "deploy" }];
      await expect("producer inventory with a stray job", () => V(fake, rec, w, "main"), /unexpected jobs: deploy/);
      fake.state.producerJobs = carried.map((j) => (j.name === "signed-build" ? { ...j, run_attempt: 5 } : j));
      await expect("producer job from beyond the latest attempt", () => V(fake, rec, w, "main"), /from 1 to the run's latest attempt 4/);
      fake.state.producerJobs = carried;
      // The root's r2 control: the jobs read is now mandatory.
      {
        const inner = fake.api.get;
        let jobsRead = 0;
        fake.api.get = async (path) => { if (path.includes("/actions/runs/321/attempts/4/jobs")) jobsRead += 1; return inner(path); };
        await expect("verify reads the producer's latest job inventory", async () => {
          await V(fake, rec, w, "main");
          if (jobsRead < 2) throw new Error(`producer jobs read ${jobsRead} time(s); want start and end`);
        });
        fake.api.get = inner;
      }
    }

    // ── the signed producer at the immutable source: shape, roster, executed steps (r5) ──
    {
      // Fresh build: this publisher run's own `build / ` call of macos.yml at S.
      const { w, fake } = fresh({ freshBuild: true }, { freshBuild: true });
      let rec;
      await expect("positive: fresh build EMIT (build / roster executed in full)", async () => { rec = await emitFor(w, fake); });
      await expect("positive: fresh build VERIFY main", () => V(fake, rec, w, "main"));
      const honest = fake.state.buildJobs;
      const named = (name) => (j) => (name.includes("(") ? j.name.startsWith(`build / ${name}`)
        : j.name === `build / ${name}` || j.name.startsWith(`build / ${name} (`));
      const without = (...names) => honest.filter((j) => !names.some((n) => named(n)(j)));
      const change = (name, fn) => honest.map((j) => (named(name)(j) ? fn(structuredClone(j)) : j));
      const stepOf = (name, stepName, fn) => change(name, (j) => ({ ...j, steps: j.steps.map((st) => (st.name === stepName ? fn(st) : st)) }));
      const cases = [
        ["fresh build without contract", without("contract"), /has 0 `contract` job\(s\)/],
        ["fresh build without test", without("test"), /has 0 `test` job\(s\)/],
        ["fresh build without either UI shard", without("ui-smoke"), /has 0 `ui-smoke\/app-shell` job\(s\)/],
        ["fresh build without contract, test and both UI shards (root r4)", without("contract", "test", "ui-smoke"), /has 0 `contract` job\(s\)/],
        ["fresh build test skipped", change("test", (j) => ({ ...j, conclusion: "skipped" })), /`test` job is completed\/skipped; every gate job must succeed/],
        ["fresh build UI shard skipped", change("ui-smoke (device-inbox", (j) => ({ ...j, conclusion: "skipped" })), /`ui-smoke\/device-inbox` job is completed\/skipped/],
        ["fresh build duplicate test job", [...honest, { ...honest.find(named("test")), id: 599 }], /has 2 `test` job\(s\)/],
        ["fresh build unknown job", [...honest, { ...honest.find(named("test")), id: 598, name: "build / deploy" }], /unexpected jobs: build \/ deploy/],
        ["fresh build missing an adoption auxiliary", without("screen"), /has 0 `screen` job\(s\)/],
        ["fresh build signed-build without its certificate import", change("signed-build", (j) => ({ ...j, steps: j.steps.filter((st) => st.name !== "Import signing certificate") })), /0 "Import signing certificate" step\(s\)/],
        ["fresh build signed step skipped", stepOf("signed-build", "Build (signed, Release)", (st) => ({ ...st, conclusion: "skipped", started_at: null, completed_at: null })), /did not execute "Build \(signed, Release\)"/],
        ["fresh build duplicate signing step", change("signed-build", (j) => ({ ...j, steps: [...j.steps, { ...j.steps.find((st) => st.name === "Package and verify DMG"), number: 99 }] })), /2 "Package and verify DMG" step\(s\)/],
        ["fresh build test step missing", change("test", (j) => ({ ...j, steps: j.steps.filter((st) => st.name !== "Release script tests") })), /0 "Release script tests" step\(s\)/],
        ["fresh build UI suite missing", change("ui-smoke (app-shell", (j) => ({ ...j, steps: j.steps.filter((st) => !st.name.startsWith("Run macOS product-flow")) })), /0 "Run macOS product-flow UI smoke \(app-shell\)" step\(s\)/],
        ["fresh build UI shard ran the other suite", change("ui-smoke (app-shell", (j) => ({ ...j, steps: [...j.steps, { number: 98, name: "Run macOS product-flow UI smoke (device-inbox)", status: "completed", conclusion: "success", started_at: null, completed_at: null }] })), /ran "Run macOS product-flow UI smoke \(device-inbox\)"/],
        ["fresh build test witnessed instead of executed", stepOf("test", WITNESS_STEPS[2], (st) => ({ ...st, conclusion: "success" })), /ran "Witness/],
        ["fresh build UI shard on a foreign runner", change("ui-smoke (app-shell", (j) => ({ ...j, labels: ["ubuntu-latest"] })), /ran on \["ubuntu-latest"\]/],
        ["fresh build evidence kept a witness in a workflow_call", stepOf("evidence", EVIDENCE_HANDOVER[0], (st) => ({ ...st, conclusion: "success" })), /in a workflow_call/],
        ["fresh build generic Work signed-build (root r4 shape)", change("signed-build", (j) => ({ ...j, steps: [j.steps[0], { number: 2, name: "Work", status: "completed", conclusion: "success", started_at: j.started_at, completed_at: j.completed_at }] })), /0 "Import signing certificate" step\(s\)/],
      ];
      for (const [label, jobs, reason] of cases) {
        fake.state.buildJobs = jobs;
        await expect(`${label} (verify)`, () => V(fake, rec, w, "main"), reason);
      }
      fake.state.buildJobs = without("contract", "test", "ui-smoke");
      await expect("fresh build roster gap refused at EMIT too", () => emitFor(w, fake), /has 0 `contract` job\(s\)/);
      fake.state.buildJobs = honest;
      const text = git(w.dir, "show", `${w.S}:.github/workflows/macos.yml`) + "\n";
      fake.state.producerWorkflow = text.replace("    runs-on: ubuntu-latest\n", "    runs-on: ubuntu-24.04\n");
      await expect("fresh build: immutable macos.yml is a non-canonical adoption", () => V(fake, rec, w, "main"), /not a proved signed build: .*not the canonical one/);
      fake.state.producerWorkflow = "name: macOS\n";
      await expect("fresh build: immutable macos.yml of another (legacy) shape than the roster", () => V(fake, rec, w, "main"), /unexpected jobs: build \/ screen, build \/ certify-macos, build \/ evidence/);
      fake.state.producerWorkflow = null;
      await expect("fresh build: immutable macos.yml unavailable", () => V(fake, rec, w, "main"), /macos\.yml at [0-9a-f]{40} could not be read/);
      fake.state.producerWorkflow = undefined;
      fake.state.producerWorkflowRaw = { path: ".github/workflows/macos.yml", encoding: "utf-8", content: text };
      await expect("fresh build: immutable macos.yml malformed answer", () => V(fake, rec, w, "main"), /contents API did not return/);
      fake.state.producerWorkflowRaw = undefined;
      // End recheck: the build's signed-build changes after the first judgement.
      {
        const inner = fake.api.get;
        let reads = 0;
        fake.api.get = async (path) => {
          if (path.includes(`/actions/runs/${PUB_RUN}/attempts/1/jobs`)) {
            reads += 1;
            if (reads === 2) fake.state.buildJobs = stepOf("signed-build", "Package and verify DMG", (st) => ({ ...st, completed_at: st.started_at }));
          }
          return inner(path);
        };
        await expect("fresh build signed-build execution changes during verify", () => V(fake, rec, w, "main"),
          /notarization or signed-build execution changed while the handoff was being verified|signed-build chain read back now differs from the chain the handoff froze/);
        fake.api.get = inner;
        fake.state.buildJobs = honest;
      }
      await expect("positive: fresh build VERIFY after the controls (exact state restored)", () => V(fake, rec, w, "main"));
    }
    {
      // Fresh build carried into a rerun-only-publish attempt 4, relabelled.
      const { w, fake } = fresh({ freshBuild: true }, { freshBuild: true, publisherAttempt: 4 });
      const relabel = (jobs) => jobs.map((j) => (j.name === "publish" ? { ...j, id: 40, run_attempt: 4 }
        : { ...j, id: j.id + 400, node_id: `CR_${j.id}`, run_attempt: 4, created_at: "2026-10-05T13:00:00Z", runner_group_id: null }));
      const attempt1 = {
        run: { id: PUB_RUN, run_attempt: 1, head_sha: w.S, path: ".github/workflows/macos-release.yml", status: "completed", conclusion: "failure" },
        jobs: [],
      };
      fake.state.history = { [PUB_RUN]: { 1: attempt1 } };
      attempt1.jobs = (await fake.api.get(`/repos/${REPO}/actions/runs/${PUB_RUN}/attempts/4/jobs?per_page=100&page=1`)).jobs
        .map((j) => (j.name === "publish" ? { ...j, conclusion: "failure" } : j));
      fake.state.publisherJobsOver = relabel;
      const emit4 = async () => {
        const saved = [fake.state.publishJob, fake.state.publisherStatus];
        fake.state.publishJob = ["in_progress", null];
        fake.state.publisherStatus = ["in_progress", null];
        try {
          return await emitHandoff(fake.api, { ...ENV(w), GITHUB_RUN_ATTEMPT: "4" }, {
            cwd: w.dir, artifactDir: w.art, candidate: w.C, branch: fake.branchName, dispatchedAt: "2026-10-05T11:58:00Z", now: NOW,
          });
        } finally {
          [fake.state.publishJob, fake.state.publisherStatus] = saved;
        }
      };
      let rec4;
      await expect("positive: fresh build carried and relabelled into attempt 4 (EMIT)", async () => { rec4 = await emit4(); });
      await expect("positive: fresh build carried and relabelled into attempt 4 (VERIFY)", () => V(fake, rec4, w, "main"));
      const keep = attempt1.jobs;
      const mutate = (fn) => { attempt1.jobs = keep.map((j) => (j.name === "build / signed-build" ? fn(structuredClone(j)) : j)); };
      mutate((j) => ({ ...j, started_at: "2026-10-05T11:22:01Z" }));
      await expect("fresh build original signed-build times differ", () => V(fake, rec4, w, "main"), /different execution/);
      mutate((j) => ({ ...j, steps: j.steps.slice(0, -1) }));
      await expect("fresh build original signed-build steps differ", () => V(fake, rec4, w, "main"), /different execution/);
      attempt1.jobs = keep.filter((j) => j.name !== "build / signed-build");
      await expect("fresh build original attempt without signed-build", () => V(fake, rec4, w, "main"), /lists 0 `build \/ signed-build`/);
      attempt1.jobs = keep;
      fake.state.history = {};
      await expect("fresh build original attempt unavailable", () => V(fake, rec4, w, "main"), /attempt 1 could not be read/);
      fake.state.history = { [PUB_RUN]: { 1: attempt1 } };
      await expect("positive: fresh build relabelled VERIFY restored", () => V(fake, rec4, w, "main"));
    }
    {
      // Reuse: the producer push run at S, same helpers, no freshness rule.
      const { w, fake } = fresh();
      const rec = await emitFor(w, fake);
      const honest = fake.state.producerJobs;
      const change = (name, fn) => honest.map((j) => (j.name === name || j.name.startsWith(`${name} (`) ? fn(structuredClone(j)) : j));
      fake.state.producerJobs = change("signed-build", (j) => ({ ...j, steps: [j.steps[0], { number: 2, name: "Work", status: "completed", conclusion: "success", started_at: j.started_at, completed_at: j.completed_at }] }));
      await expect("reused signed-build with generic Work steps (root r4)", () => V(fake, rec, w, "main"), /0 "Import signing certificate" step\(s\)/);
      fake.state.producerJobs = change("test", (j) => ({ ...j, conclusion: "skipped" }));
      await expect("reused producer test skipped", () => V(fake, rec, w, "main"), /`test` job is completed\/skipped/);
      fake.state.producerJobs = change("contract", (j) => ({ ...j, labels: ["macos-14"] }));
      await expect("reused producer contract on a foreign runner", () => V(fake, rec, w, "main"), /ran on \["macos-14"\]/);
      fake.state.producerJobs = change("evidence", (j) => ({ ...j, steps: j.steps.filter((st) => st.name !== REQUIRED_STEPS.evidence[0]) }));
      await expect("reused producer evidence job without its decision step", () => V(fake, rec, w, "main"), /0 "Does the merged pull request's full proof cover this main tree\?" step/);
      fake.state.producerJobs = change("signed-build", (j) => ({ ...j, name: "build / signed-build" }));
      await expect("reused producer with a prefixed (called) signed-build", () => V(fake, rec, w, "main"), /unexpected jobs: build \/ signed-build/);
      fake.state.producerJobs = honest;
      fake.state.producerWorkflow = null;
      await expect("reused producer: immutable macos.yml unavailable", () => V(fake, rec, w, "main"), /could not be read/);
      fake.state.producerWorkflow = "name: macOS\n";
      // Before adoption there was no witness path: no witness step is reported.
      fake.state.producerJobs = honest.slice(3).map((j) => ({ ...j, steps: j.steps.filter((st) => !WITNESS_STEPS.includes(st.name)) }));
      // A v1 record keeps its executed-only verification; a v2 record froze the
      // decision's shape and refuses a producer that now reads otherwise.
      await expect("positive: v1 record, reused producer of a legacy (pre-adoption) macos.yml with the five jobs", () => V(fake, asV1(rec), w, "main"));
      await expect("v2 record refuses a producer shape other than the decision froze", () => V(fake, rec, w, "main"),
        /reads as executed coverage|producer workflow at the source is not the one the decision froze/);
      fake.state.producerJobs = honest;
      await expect("v1 record: reused legacy macos.yml with adoption jobs listed", () => V(fake, asV1(rec), w, "main"), /unexpected jobs: screen, certify-macos, evidence/);
      fake.state.producerWorkflow = undefined;
      // Historical: verify carries no freshness or current-workflow rule.
      await expect("positive: reused producer verified long after the week reuse selection allows", () => V(fake, rec, w, "main", { now: Date.parse("2026-10-18T00:00:00Z") }));
    }

    // ── rerun-only-publish recovery: a carried (relabelled) notarize-stage ──
    {
      const { w, fake } = fresh(undefined, { publisherAttempt: 4 });
      // Attempt 1: notarized, then its publish job FAILED. Attempt 4 re-ran
      // only publish; GitHub lists the carried jobs relabelled 4 with new ids.
      const relabel = (jobs) => jobs.map((j) => (j.name === "publish" ? { ...j, id: 40, run_attempt: 4 }
        : { ...j, id: j.id + 400, node_id: `CR_${j.id}`, run_attempt: 4, created_at: "2026-10-05T13:00:00Z", runner_group_id: null }));
      const original = (status) => ({
        run: { id: PUB_RUN, run_attempt: 1, head_sha: w.S, path: ".github/workflows/macos-release.yml", status: "completed", conclusion: "failure" },
        jobs: [],
        status,
      });
      fake.state.publisherJobsOver = relabel;
      const attempt1 = original();
      fake.state.history = { [PUB_RUN]: { 1: attempt1 } };
      const capture = () => {
        const saved = fake.state.publisherJobsOver;
        fake.state.publisherJobsOver = null;
        const jobs = fake.state.publishJob;
        fake.state.publishJob = ["completed", "failure"];
        return { restore: () => { fake.state.publisherJobsOver = saved; fake.state.publishJob = jobs; } };
      };
      {
        // Snapshot the ORIGINAL attempt-1 inventory from the same world.
        const c = capture();
        attempt1.jobs = (await fake.api.get(`/repos/${REPO}/actions/runs/${PUB_RUN}/attempts/4/jobs?per_page=100&page=1`)).jobs
          .map((j) => (j.name === "publish" ? { ...j, conclusion: "failure" } : j));
        c.restore();
      }
      const emit4 = async () => {
        const saved = [fake.state.publishJob, fake.state.publisherStatus];
        fake.state.publishJob = ["in_progress", null];
        fake.state.publisherStatus = ["in_progress", null];
        try {
          return await emitHandoff(fake.api, { ...ENV(w), GITHUB_RUN_ATTEMPT: "4" }, {
            cwd: w.dir, artifactDir: w.art, candidate: w.C, branch: fake.branchName, dispatchedAt: "2026-10-05T11:58:00Z", now: NOW,
          });
        } finally {
          [fake.state.publishJob, fake.state.publisherStatus] = saved;
        }
      };
      let rec4;
      await expect("positive: EMIT at publish attempt 4 with notary provenance attempt 1 relabelled 4", async () => {
        rec4 = await emit4();
        if (rec4.publisher.attempt !== 4) throw new Error(`record names attempt ${rec4.publisher.attempt}`);
      });
      await expect("positive: VERIFY the attempt-4 handoff (original attempt 1 failed overall)", () => V(fake, rec4, w, "main"));
      const keep = attempt1.jobs;
      const mutateOriginal = (fn) => { attempt1.jobs = keep.map((j) => (j.name === "notarize-stage" ? fn({ ...j }) : j)); };
      mutateOriginal((j) => ({ ...j, started_at: "2026-10-05T11:31:00Z" }));
      await expect("notary re-executed (times differ from attempt 1)", () => emit4(), /different execution/);
      attempt1.jobs = keep.map((j) => (j.name === "preflight" ? { ...j, completed_at: "2026-10-05T11:21:01Z" } : j));
      await expect("v2: preflight re-executed (attempt 4 is not the decision's attempt-1 execution)", () => emit4(), /run 900 `preflight`: attempt 4 lists a different execution/);
      mutateOriginal((j) => ({ ...j, steps: j.steps.slice(0, 2) }));
      await expect("notary with one step missing", () => emit4(), /different execution/);
      attempt1.jobs = keep.filter((j) => j.name !== "notarize-stage");
      await expect("original attempt without notarize-stage", () => emit4(), /lists 0 `notarize-stage`/);
      attempt1.jobs = [...keep, keep.find((j) => j.name === "notarize-stage")];
      await expect("original attempt with two notarize-stage jobs", () => emit4(), /lists 2 `notarize-stage`/);
      mutateOriginal((j) => ({ ...j, conclusion: "failure" }));
      await expect("original notarize-stage failed", () => emit4(), /not a completed success/);
      mutateOriginal((j) => ({ ...j, run_id: 1 }));
      await expect("original job of another run", () => emit4(), /lists job .* of run 1/);
      attempt1.jobs = keep;
      fake.state.history = {};
      await expect("original attempt inventory unavailable", () => emit4(), /attempt 1 could not be read/);
      fake.state.history = { [PUB_RUN]: { 1: attempt1 } };
      const savedRun = attempt1.run;
      attempt1.run = { ...savedRun, head_sha: w.C };
      await expect("original attempt on another head", () => emit4(), /not a completed attempt/);
      attempt1.run = savedRun;
      fake.state.publisherJobsOver = (jobs) => relabel(jobs).map((j) => (j.name === "notarize-stage" ? { ...j, run_attempt: 2 } : j));
      await expect("latest wrapper labelled a third attempt", () => emit4(), /labelled attempt 2 in attempt 4/);
      fake.state.publisherJobsOver = relabel;
      const art = fake.state.artifact;
      fake.state.artifact = { ...art, created_at: "2026-10-05T11:42:00Z" };
      await expect("artifact outside the original notarize-stage window", () => emit4(), /outside notarize-stage .*attempt 1/);
      fake.state.artifact = art;
      // End re-read: the original execution changes after the start.
      {
        // Triggered by the first tree read, which follows the artifact and
        // origin judgement at the start of verify.
        const inner = fake.api.get;
        fake.api.get = async (path) => {
          const v = await inner(path);
          if (path.includes("/git/trees/")) {
            attempt1.jobs = keep.map((j) => (j.name === "notarize-stage" ? { ...j, completed_at: "2026-10-05T11:40:59Z",
              steps: j.steps.map((st) => (st.completed_at === "2026-10-05T11:41:00Z" ? { ...st, completed_at: "2026-10-05T11:40:59Z" } : st)) } : j));
          }
          return v;
        };
        await expect("original execution changed during verification", () => V(fake, rec4, w, "main"), /different execution/);
        fake.api.get = inner;
        attempt1.jobs = keep;
      }
      {
        // Both sides change identically at the end: each judge alone still
        // sees one execution, only the retained start anchor refuses.
        const inner = fake.api.get;
        const shift = (j) => (j.name === "notarize-stage" ? { ...j, steps: j.steps.map((st) => (st.number === 3 ? { ...st, name: "Swapped" } : st)) } : j);
        fake.api.get = async (path) => {
          const v = await inner(path);
          if (path.includes("/git/trees/")) {
            attempt1.jobs = keep.map(shift);
            fake.state.publisherJobsOver = (jobs) => relabel(jobs).map(shift);
          }
          return v;
        };
        await expect("original and latest execution both replaced during verification", () => V(fake, rec4, w, "main"),
          /notarization or signed-build execution changed while the handoff was being verified/);
        fake.api.get = inner;
        attempt1.jobs = keep;
        fake.state.publisherJobsOver = relabel;
      }
      fake.state.publisherAttempt = 5;
      await expect("old attempt-4 record after another publish attempt", () => V(fake, rec4, w, "main"), /publisher run is now attempt 5/);
    }

    // ── end-of-verify re-read of mutable state ──
    {
      const { w, fake } = fresh();
      const rec = await emitFor(w, fake);
      fake.state.main = w.C;
      const atEnd = async (label, mutateState, reason, extra) => {
        const inner = fake.api.getOptional;
        const saved = JSON.stringify({ p: fake.state.publisherAttempt, g: fake.state.gateRunOver, a: fake.state.producerAttempt });
        fake.api.getOptional = async (path) => {
          const v = await inner(path);
          if (path === `/repos/${REPO}/releases/tags/${rec.release.tag}`) mutateState();
          return v;
        };
        await expect(label, () => V(fake, rec, w, "release", extra), reason);
        fake.api.getOptional = inner;
        const back = JSON.parse(saved);
        Object.assign(fake.state, { publisherAttempt: back.p, gateRunOver: back.g, producerAttempt: back.a });
      };
      await atEnd("positive: unchanged state at the end re-read", () => {}, undefined);
      await atEnd("publisher re-run during verification", () => { fake.state.publisherAttempt = 2; }, /publisher run is now attempt 2/);
      await atEnd("gate turned red during verification", () => { fake.state.gateRunOver = { conclusion: "failure" }; }, /merge-gate run 777 (changed while|is completed\/failure)/);
      await atEnd("producer re-run during verification", () => {
        fake.state.producerAttempt = 2;
        fake.state.history = { 321: { 1: { jobs: fake.state.producerJobs,
          run: { id: 321, run_attempt: 1, head_sha: w.S, path: ".github/workflows/macos.yml", status: "completed", conclusion: "failure" } } } };
      }, /producer run 321 is now attempt 2|notarization or signed-build execution changed while the handoff was being verified/);
      fake.state.history = undefined;
      let calls = 0;
      const clock = () => ((calls += 1) === 1 ? NOW : Date.parse("2026-10-20T00:00:00Z"));
      await atEnd("artifact expired by the end of verification (fresh clock)", () => {}, /expired/, { clock, now: undefined });
    }

    // ── workflows-directory comparison ──
    {
      const { w, fake } = fresh();
      await expect("positive: same workflows tree in workflow mode", async () => {
        const r = await compareWorkflows(fake.api, { repository: REPO, sha: w.S, mode: "workflow" });
        if (!r.match) throw new Error("expected match");
      });
      await expect("unknown delivery mode fails closed", () => compareWorkflows(fake.api, { repository: REPO, sha: w.S, mode: "" }), /metadata_delivery ""/);
      fake.state.truncated = true;
      await expect("truncated tree is unknown, not a match", () => compareWorkflows(fake.api, { repository: REPO, sha: w.S, mode: "operator" }), /truncated/);
    }
    {
      const { w, fake } = fresh({ workflowDrift: true });
      await expect("workflows mismatch refused in workflow mode", () => compareWorkflows(fake.api, { repository: REPO, sha: w.S, mode: "workflow" }), /different .github\/workflows trees/);
      await expect("positive: workflows mismatch reported in operator mode", async () => {
        const r = await compareWorkflows(fake.api, { repository: REPO, sha: w.S, mode: "operator" });
        if (r.match) throw new Error("expected mismatch");
      });
      await expect("bad source SHA", () => compareWorkflows(fake.api, { repository: REPO, sha: "abc", mode: "operator" }), /not a commit SHA/);
    }

    // ── v2 signedBuild: strict schema and the executed reuse decision ──
    {
      const { w, fake } = fresh();
      const rec = await emitFor(w, fake);
      await expect("positive: v2 executed reuse binds the preflight decision", () => {
        const sb = rec.signedBuild;
        if (rec.schema !== HANDOFF_SCHEMA || sb.kind !== "main-push" || sb.runId !== 321 || sb.originalAttempt !== 1
          || sb.coverage.mode !== "executed" || sb.decision.identity.id !== 56 || sb.decision.attempt !== 1
          || sb.decision.mode !== "auto") throw new Error(JSON.stringify(sb));
      });
      await expect("positive: v1 record of the same chain still verifies executed-only", () => V(fake, asV1(rec), w, "main"));
      const mut = (fn) => { const r = JSON.parse(JSON.stringify(rec)); fn(r); return JSON.stringify(r); };
      await expect("v2 schema: signedBuild missing", () => parseHandoff(mut((r) => { delete r.signedBuild; })), /schema requires exactly/);
      await expect("v1 schema: carrying signedBuild", () => parseHandoff(mut((r) => { r.schema = HANDOFF_SCHEMA_V1; })), /schema requires exactly/);
      await expect("v2 schema: signedBuild extra key", () => parseHandoff(mut((r) => { r.signedBuild.extra = 1; })), /signedBuild has keys/);
      await expect("v2 schema: unknown kind", () => parseHandoff(mut((r) => { r.signedBuild.kind = "artifact"; })), /kind "artifact" is unknown/);
      await expect("v2 schema: publisher-build carrying a decision", () => parseHandoff(mut((r) => { r.signedBuild.kind = "publisher-build"; r.signedBuild.runId = PUB_RUN; })), /carries no reuse decision/);
      await expect("v2 schema: main-push without a decision", () => parseHandoff(mut((r) => { r.signedBuild.decision = null; })), /decision must have exactly/);
      await expect("v2 schema: decision of another commit", () => parseHandoff(mut((r) => { r.signedBuild.decision.identity.name = `relayium-macos-build-source-${w.C}-attempt-1`; })), /not the publisher preflight's decision/);
      await expect("v2 schema: decision identity missing a field", () => parseHandoff(mut((r) => { delete r.signedBuild.decision.identity.head_repository_id; })), /not one complete artifact identity/);
      await expect("v2 schema: decision from a later attempt", () => parseHandoff(mut((r) => { r.signedBuild.decision.attempt = 2; })), /not an attempt of the publisher run/);
      await expect("v2 schema: malformed coverage", () => parseHandoff(mut((r) => { r.signedBuild.coverage.extra = 1; })), /coverage is malformed/);
      await expect("v2 schema: unknown shape", () => parseHandoff(mut((r) => { r.signedBuild.shape = "non-canonical"; })), /shape "non-canonical" is unknown/);
      await expect("v2 schema: reused signed artifact of another commit", () => parseHandoff(mut((r) => { r.signedBuild.signedArtifact.name = `relayium-macos-signed-${w.C}-ci`; })), /not the reused signed artifact of the source commit/);
      await expect("v2 schema: reused signed artifact missing", () => parseHandoff(mut((r) => { r.signedBuild.signedArtifact = null; })), /not the reused signed artifact/);
      await expect("positive: v2 executed reuse freezes the decision's signed artifact", () => {
        if (JSON.stringify(rec.signedBuild.signedArtifact) !== JSON.stringify({ id: 77, name: `relayium-macos-signed-${w.S}-ci`, digest: `sha256:${"e".repeat(64)}` })) throw new Error(JSON.stringify(rec.signedBuild.signedArtifact));
      });
      const otherArtifact = parseHandoff(mut((r) => { r.signedBuild.signedArtifact.digest = `sha256:${"0".repeat(64)}`; }));
      await expect("v2 well-formed record naming another reused signed artifact", () => V(fake, otherArtifact, w, "main"), /chain read back now differs/);
      const forged = parseHandoff(mut((r) => { r.signedBuild.execution = "0".repeat(64); }));
      await expect("v2 well-formed record naming another signed execution", () => V(fake, forged, w, "main"), /chain read back now differs/);
      const otherPreflight = parseHandoff(mut((r) => { r.signedBuild.decision.preflight = "0".repeat(64); }));
      await expect("v2 well-formed record naming another preflight execution", () => V(fake, otherPreflight, w, "main"), /chain read back now differs/);
      const keepDecision = fake.state.decisionArtifact;
      fake.state.decisionArtifact = null;
      await expect("v2 decision artifact absent at verify", () => V(fake, rec, w, "main"), /carries 0 signed-build source decisions/);
      await expect("v2 decision artifact absent at emit", () => emitFor(w, fake), /carries 0 signed-build source decisions/);
      fake.state.decisionArtifact = { ...keepDecision, expired: true };
      await expect("v2 decision artifact expired", () => V(fake, rec, w, "main"), /decision artifact 56 has expired/);
      fake.state.decisionArtifact = { ...keepDecision, digest: `sha256:${"0".repeat(64)}` };
      await expect("v2 decision artifact digest changed", () => V(fake, rec, w, "main"), /not the frozen decision/);
      await expect("v2 decision bytes not the API digest (emit)", () => emitFor(w, fake), /do not hash to its API digest/);
      fake.state.decisionArtifact = { ...keepDecision, created_at: "2026-10-05T11:20:20Z" };
      await expect("v2 decision uploaded inside Select, outside Upload (emit)", () => emitFor(w, fake), /outside the preflight's "Upload the signed-build source decision" step/);
      fake.state.decisionArtifact = keepDecision;
      fake.state.preflightOver = { started_at: "2026-10-05T11:20:01Z" };
      await expect("v2 latest preflight is another execution than the decision's", () => V(fake, rec, w, "main"), /chain read back now differs/);
      fake.state.preflightOver = undefined;
      const swapDecision = async (over, label, reason) => {
        const f2 = fakeApi(w, { evidenceOver: over });
        await expect(label, () => emitFor(w, f2), reason);
      };
      await swapDecision({ signedBuildOrigin: undefined, coverage: undefined }, "v2 emit refuses a pre-v2 decision (no signedBuildOrigin/coverage)", /predates signedBuildOrigin\/coverage evidence/);
      await swapDecision({ run: { id: 322, attempt: 1, event: "push", headBranch: "main", conclusion: "success", createdAt: "2026-10-05T10:00:00Z", runStartedAt: null } },
        "v2 emit refuses a decision for another producer run", /decision reused run 322/);
      await swapDecision({ files: { "Relayium.dmg": "9".repeat(64), "Relayium.dmg.sha256": "1".repeat(64), "provenance.json": "2".repeat(64), "release-tools/generate_appcast": "d".repeat(64) } },
        "v2 emit refuses a decision for another signed payload", /not the package the notarized provenance names/);
      await swapDecision({ toolchain: { xcode: "Xcode 16.3", swift: "Swift 6.1.2", macos: "15.7.9", runnerImage: "macos15/1" } },
        "v2 emit refuses a decision with another toolchain", /version, build or toolchain/);
      await swapDecision({ extra: true }, "v2 emit refuses a decision with an extra evidence key", /evidence has keys/);
      {
        const f2 = fakeApi(w);
        f2.state.publisherJobsOver = (jobs) => jobs.map((j) => (j.name === "preflight"
          ? { ...j, steps: j.steps.map((st) => (st.number === 5 ? { ...st, conclusion: "failure" } : st)) } : j));
        await expect("v2 emit refuses a decision whose upload step did not succeed", () => emitFor(w, f2), /did not run "Upload the signed-build source decision" exactly once successfully/);
        const f3 = fakeApi(w);
        f3.state.decisionArtifact = { ...f3.state.decisionArtifact };
        const second = { ...f3.state.decisionArtifact, id: 57, name: `relayium-macos-build-source-${w.S}-attempt-2` };
        const inner = f3.api.get;
        f3.api.get = async (path) => {
          const v = await inner(path);
          return path.startsWith(`/repos/${REPO}/actions/runs/${PUB_RUN}/artifacts`) ? { ...v, total_count: v.total_count + 1, artifacts: [...v.artifacts, second] } : v;
        };
        await expect("v2 emit refuses a re-decided preflight (two decision artifacts)", () => emitFor(w, f3), /carries 2 signed-build source decisions/);
      }
      const summary = handoffSummary(rec);
      await expect("v2 summary names the frozen reuse decision and a truthful verifiable-until", () => {
        if (!summary.includes("frozen from preflight decision artifact 56") || !summary.includes(`Verifiable until ${rec.artifact.expiresAt}`)
          || !/proves nothing more/.test(summary) || /publish(ed)?\b/i.test(summary.replace("NOT PUBLISHED", "").replace("publishing then needs", ""))) throw new Error(summary);
      });
    }
    // ── v2 legacy-shape reuse: the decision froze a legacy producer ──
    {
      const { w } = fresh();
      const jobs = producerRoster({ runId: 321, sha: w.S, start: "2026-10-05T10:00:00Z" }).slice(3)
        .map((j) => ({ ...j, steps: j.steps.filter((st) => !WITNESS_STEPS.includes(st.name)) }));
      const fake = fakeApi(w, { producerWorkflow: "name: macOS\n", producerJobs: jobs,
        evidenceOver: { workflow: { id: 1, path: ".github/workflows/macos.yml", shape: "legacy", blob: "f".repeat(40) } } });
      let rec;
      await expect("positive: v2 emit of a legacy-shape executed reuse", async () => { rec = await emitFor(w, fake); });
      await expect("positive: v2 verify of a legacy-shape executed reuse", () => V(fake, rec, w, "main"));
    }

    // ── the command ──
    await expect("unknown command", () => handoffMain(["publish"], {}, () => ({})), /usage/);
    await expect("production verify refuses a clock override", () => handoffMain(
      ["verify", "--record", "/nonexistent", "--stage", "main", "--artifact-dir", "/tmp", "--now", "2026-01-01T00:00:00Z"],
      {}, () => ({})), /unknown flag --now/);
    await expect("production emit refuses a clock override", () => handoffMain(["emit", "--now", "2026-01-01T00:00:00Z"], {}, () => ({})), /unknown flag --now/);

    // ── the certified chain, whole: actual decide/readback, emit, verify main and release ──
    await certifiedCases(expect);

    // ── the full-bootstrap producer, whole: select/decide/readback and H re-proof ──
    await bootstrapCases(expect);

    // ── the full-bootstrap producer through the publisher: actual decide/readback, emit v3, verify main and release ──
    await bootstrapHandoffCases(expect);

    // ── the workflow: operator mode cannot reach the writes ──
    workflowControls(failures, () => { passed += 1; });
  } finally {
    for (const d of cleanup) rmSync(d, { recursive: true, force: true });
  }
  return { failures, passed };
}

/**
 * The certified handoff on the accepted root world: real Git objects, the
 * genuine `produce`/`witness` proof chain, the preflight's ACTUAL `decide`
 * record and the notarize-stage's ACTUAL `readback` (both the shipped
 * library), then the shipped emit and verify. Every family runs its positive
 * first; every refusal is matched by reason.
 */
export async function certifiedCases(expect) {
  const w = await handoffWorld({ gateJobs: honestGateJobs });
  const at = w.now.getTime();
  const R = w.repository;
  const clockAt = (ms) => () => ms;
  const raw = (rec) => JSON.parse(JSON.stringify(rec));
  try {
    let rec;
    await expect("certified: positive EMIT freezes the preflight's certified chain", async () => { rec = await w.emit(); });
    const ev = w.decisionRecord.evidence;
    const decisionArt = w.artifacts.find((a) => a.name.includes("build-source"));
    await expect("certified: record binds the decision's exact chain (not a reselection)", () => {
      const sb = rec.signedBuild;
      const bad = [];
      if (rec.schema !== HANDOFF_SCHEMA || sb.kind !== "main-push" || sb.runId !== w.main.id) bad.push("kind/run");
      if (sb.coverage.mode !== "certified-full-proof" || JSON.stringify(sb.coverage) !== JSON.stringify(ev.coverage)) bad.push("coverage");
      if (sb.originalAttempt !== ev.signedBuildOrigin.attempt || sb.execution !== ev.signedBuildOrigin.execution) bad.push("signed origin");
      if (sb.originalAttempt !== sb.coverage.witness.attempt) bad.push("witness attempt");
      if (JSON.stringify(sb.decision.identity) !== JSON.stringify(artifactIdentityOf(decisionArt)) || sb.decision.attempt !== 1) bad.push("decision identity");
      if (sb.decision.decidedAt !== w.decisionRecord.decidedAt || sb.decision.mode !== "reuse") bad.push("decision time/mode");
      if (JSON.stringify(sb.signedArtifact) !== JSON.stringify({ id: ev.artifact.id, name: ev.artifact.name, digest: ev.artifact.digest })) bad.push("signed artifact");
      if (bad.length) throw new Error(bad.join(", "));
    });
    await expect("certified: emit and verify never run a new selection", async () => {
      w.reset();
      await w.verify(rec, "main");
      const selectionReads = w.calls.filter((c) => c.endsWith("actions/workflows/macos.yml") || c.includes("actions/workflows/321216057/runs"));
      if (selectionReads.length) throw new Error(selectionReads.join(", "));
    });
    await expect("certified: positive VERIFY main", () => w.verify(rec, "main"));
    const independent = w.independentDmgSha();
    await expect("certified: independent disk SHA of the handed-off DMG", () => {
      const zipDmg = createHash("sha256").update(w.files.get("Relayium.dmg")).digest("hex");
      if (independent !== rec.dmg.sha256 || zipDmg !== independent) throw new Error(`${independent} / ${rec.dmg.sha256}`);
    });
    w.deliverMain();
    await expect("certified: positive VERIFY release (tag absent)", () => w.verify(rec, "release"));
    await expect("certified: v1 form of a certified chain is refused (never inferred certified)", () => w.verify(asV1(rec), "release"),
      /witness|executed|did not execute|not a proved signed build/);
    const until = verifiableUntil(rec);
    await expect("certified: verifiableUntil is the earliest retained chain expiry", () => {
      const sb = rec.signedBuild;
      const all = [rec.artifact.expiresAt, sb.decision.identity.expires_at, sb.coverage.witness.identity.expires_at,
        sb.coverage.source.proofIdentity.expires_at, ...Object.values(sb.coverage.certificates).flatMap((c) => c.artifacts.map((a) => a.expires_at))];
      const min = all.reduce((m, t) => (Date.parse(t) < Date.parse(m) ? t : m));
      if (until !== min || Date.parse(until) >= Date.parse(rec.artifact.expiresAt)) throw new Error(`${until} vs ${min}`);
      if (!handoffSummary(rec).includes(`Verifiable until ${until}`)) throw new Error("summary");
    });

    // Original source eligibility, judged at the witness's own verified_at,
    // survives a source that is now older than any new reuse may use.
    const later = at + 49 * 3600000;
    await expect("certified: original source > 48h at NOW still verifies historically (release)", () => w.verify(rec, "release", { clock: clockAt(later) }));
    await expect("certified: a new auto selection at the same NOW rebuilds", async () => {
      const d = await w.inCheckout(() => decide(w.world.api, { mode: "auto", repository: R, repositoryId: w.repositoryId, sha: w.sha,
        ref: "refs/heads/main", releaseVersion: "1.4.5", now: later, dir: join(w.directory, "later-auto") }));
      if (d.source !== "build" || !/outside 48h/.test(d.reason)) throw new Error(`${d.source}: ${d.reason}`);
    });
    await expect("certified: a new forced reuse at the same NOW is refused", () => w.inCheckout(() => decide(w.world.api, { mode: "reuse",
      repository: R, repositoryId: w.repositoryId, sha: w.sha, ref: "refs/heads/main", releaseVersion: "1.4.5", now: later,
      dir: join(w.directory, "later-reuse") })), /outside 48h/);
    await expect("certified: the notarize readback at the same NOW is refused", () => w.inCheckout(() => readback(w.world.api, ev,
      { now: later, dir: join(w.directory, "later-readback"), releaseVersion: "1.4.5" })), /outside 48h/);
    await expect("certified: positive EMIT at the same later NOW freezes the identical chain", async () => {
      w.state.main = w.sha;
      try {
        const again = await w.emit({ now: later });
        if (JSON.stringify(again.signedBuild) !== JSON.stringify(rec.signedBuild)) throw new Error("different chain");
      } finally { w.deliverMain(); }
    });
    // Expiry at the machine clock NOW.
    await expect("certified: positive just before verifiableUntil", () => w.verify(rec, "release", { clock: clockAt(Date.parse(until) - 60000) }));
    await expect("certified: refused once the earliest chain artifact has expired", () => w.verify(rec, "release", { clock: clockAt(Date.parse(until) + 1000) }),
      /expired|expiry/);
    {
      let calls = 0;
      const jump = () => ((calls += 1) <= 3 ? at : Date.parse(until) + 1000);
      await expect("certified: a fresh clock read during verify sees the chain expire", () => w.verify(rec, "release", { clock: jump }), /expired|expiry/);
    }

    // End clock: every read sees a valid clock; only the FINAL API answer
    // moves the machine clock past verifiableUntil. Positive first.
    {
      const branchRoute = `repos/${R}/git/ref/heads/${w.branchName}`;
      const endClock = async (label, stage, setup) => {
        setup();
        try {
          await expect(`certified: end-clock positive VERIFY ${stage} (unmoved clock)`, () => w.verify(rec, stage, { clock: clockAt(at) }));
          w.reset();
          let now = at;
          w.hooks.set(branchRoute, (n) => { if (n === 2) now = Date.parse(until) + 1000; return undefined; });
          await expect(label, async () => {
            try { await w.verify(rec, stage, { clock: () => now }); } finally {
              if (w.counters.get(branchRoute) !== 2 || !(now > Date.parse(until))) {
                throw new Error(`control not triggered: branch reads ${w.counters.get(branchRoute)}, clock ${new Date(now).toISOString()}`);
              }
            }
          }, /the retained chain expired at .* before the handoff verification finished/);
        } finally { w.reset(); w.deliverMain(); }
      };
      await endClock("certified: VERIFY main refused when the chain expires after the final branch answer", "main",
        () => { w.state.main = rec.candidate.base; });
      await endClock("certified: VERIFY release refused when the chain expires after the final branch answer", "release", () => {});

      // Emission: learn the final API answer of a positive emit, then move the
      // clock only on that answer; no stale record may be emitted.
      w.state.main = w.sha;
      try {
        w.reset();
        await expect("certified: end-clock positive EMIT (unmoved clock)", () => w.emit({ clock: clockAt(at) }));
        const last = w.calls.at(-1);
        const lastN = w.counters.get(last);
        w.reset();
        let now = at;
        w.hooks.set(last, (n) => { if (n === lastN) now = Date.parse(until) + 1000; return undefined; });
        await expect("certified: EMIT refused when the chain expires after its final API answer", async () => {
          try { await w.emit({ clock: () => now }); } finally {
            if (w.counters.get(last) !== lastN || !(now > Date.parse(until))) {
              throw new Error(`control not triggered: ${last} read ${w.counters.get(last)}/${lastN}`);
            }
          }
        }, /the retained chain expired at .* before the handoff record was emitted/);
      } finally { w.reset(); w.deliverMain(); }
    }

    // Well-formed, parseable, but not the chain the preflight froze.
    const variant = (fn) => { const r = raw(rec); fn(r); return parseHandoff(JSON.stringify(r)); };
    await expect("certified: frozen coverage execution mismatch", () => w.verify(variant((r) => {
      const k = Object.keys(r.signedBuild.coverage.executions)[0]; r.signedBuild.coverage.executions[k] = "0".repeat(64);
    }), "release"), /chain read back now differs from the chain the handoff froze/);
    await expect("certified: frozen certificate identity mismatch", () => w.verify(variant((r) => {
      r.signedBuild.coverage.certificates.test.artifacts[0].size_in_bytes += 1;
    }), "release"), /chain read back now differs from the chain the handoff froze/);
    await expect("certified: frozen decision identity mismatch (expiry)", () => w.verify(variant((r) => {
      r.signedBuild.decision.identity.expires_at = new Date(Date.parse(r.signedBuild.decision.identity.expires_at) + 1000).toISOString().replace(".000Z", "Z");
    }), "release"), /not the frozen decision/);
    await expect("certified: frozen decision time mismatch", () => w.verify(variant((r) => { r.signedBuild.decision.decidedAt = "2026-01-01T00:00:00Z"; }), "release"),
      /chain read back now differs/);
    await expect("certified: schema refuses a certified attempt other than the signed original", () => parseHandoff(JSON.stringify((() => {
      const r = raw(rec); r.signedBuild.originalAttempt = 2; r.publisher.attempt = 2;
      r.candidate.branch = `release-candidate/macos-v1.4.5-${r.publisher.runId}-2`; return r;
    })())), /not of the signed build's own run, commit and original attempt/);
    await expect("certified: schema refuses certified coverage on a legacy producer", () => parseHandoff(JSON.stringify((() => {
      const r = raw(rec); r.signedBuild.shape = "legacy"; return r; })())), /cannot describe a legacy producer/);
    await expect("certified: schema refuses a malformed frozen coverage", () => parseHandoff(JSON.stringify((() => {
      const r = raw(rec); r.signedBuild.coverage.source.extra = "untrusted"; return r; })())), /coverage is malformed/);

    // Same-value replacements: the bytes are equal, the identity is not.
    {
      const keepId = decisionArt.id;
      const bytes = w.zips.get(keepId);
      decisionArt.id = keepId + 7;
      w.zips.set(decisionArt.id, bytes);
      try {
        await expect("certified: decision replaced by the same bytes under a new id", () => w.verify(rec, "release"), /not the frozen decision/);
      } finally { w.zips.delete(decisionArt.id); decisionArt.id = keepId; }
      const cert = w.world.artifacts.find((a) => a.name === "relayium-ci-evidence-toolchain-macos-test-0-attempt-1");
      const certId = cert.id;
      w.world.zipBytes.set(certId + 100000, w.world.zipBytes.get(certId));
      cert.id += 100000;
      try {
        await expect("certified: source certificate replaced by the same value under a new id", () => w.verify(rec, "release"),
          /certified coverage read back now differs|frozen certified coverage no longer holds/);
      } finally { w.world.zipBytes.delete(cert.id); cert.id = certId; }
    }

    // The original preflight: swapped identity or value.
    {
      const keepZip = w.zips.get(decisionArt.id);
      const keepMeta = { digest: decisionArt.digest, size: decisionArt.size_in_bytes, created: decisionArt.created_at };
      const swap = (record) => {
        const bytes = storedZip([{ name: "reuse-decision.json", data: `${JSON.stringify(record, null, 2)}\n` }]);
        w.zips.set(decisionArt.id, bytes);
        decisionArt.digest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
        decisionArt.size_in_bytes = bytes.length;
      };
      const restore = () => { w.zips.set(decisionArt.id, keepZip); decisionArt.digest = keepMeta.digest; decisionArt.size_in_bytes = keepMeta.size; decisionArt.created_at = keepMeta.created; };
      w.state.main = w.sha;
      try {
        swap({ ...w.decisionRecord, reason: "another reason" });
        await expect("certified: decision value swapped (verify sees another digest)", () => { w.deliverMain(); return w.verify(rec, "release"); }, /not the frozen decision/);
        w.state.main = w.sha;
        swap({ ...w.decisionRecord, decidedAt: new Date(Date.parse(w.decisionRecord.decidedAt) + 60000).toISOString() });
        await expect("certified: decision made outside the original Select step (emit)", () => w.emit(), /outside the preflight's "Select the signed-build source" step/);
        const { signedBuildOrigin, coverage, ...v1Evidence } = w.decisionRecord.evidence;
        swap({ ...w.decisionRecord, evidence: v1Evidence });
        await expect("certified: v1 decision without origin/coverage is never inferred certified (emit)", () => w.emit(), /predates signedBuildOrigin\/coverage evidence/);
        swap({ ...w.decisionRecord, evidence: { ...w.decisionRecord.evidence, coverage: { mode: "executed" } } });
        await expect("certified: decision claiming executed coverage for a certified producer (emit)", () => w.emit(), /reads as certified-full-proof coverage; the decision froze executed/);
        const executedRun = structuredClone(w.decisionRecord.evidence);
        executedRun.signedBuildOrigin = { ...executedRun.signedBuildOrigin, execution: "0".repeat(64) };
        swap({ ...w.decisionRecord, evidence: executedRun });
        await expect("certified: decision naming another signed execution (emit)", () => w.emit(), /not the one the decision froze/);
        restore();
        decisionArt.created_at = w.preflight.steps.find((st) => st.name === "Select the signed-build source").started_at;
        await expect("certified: decision artifact created in Select, not the later Upload step (emit)", () => w.emit(),
          /outside the preflight's "Upload the signed-build source decision" step/);
        restore();
        const pre = w.preflight;
        const keepSteps = pre.steps;
        pre.steps = keepSteps.map((st) => (st.name === "Select the signed-build source" ? { ...st, completed_at: st.started_at } : st));
        await expect("certified: latest preflight is another execution than the frozen one", () => { w.deliverMain(); return w.verify(rec, "release"); },
          /chain read back now differs from the chain the handoff froze/);
        pre.steps = keepSteps;
      } finally { restore(); w.deliverMain(); }
    }

    // A carried producer rerun keeps the execution; a re-executed signed build does not.
    {
      const main = w.main;
      const keepRun = structuredClone(main);
      const carried = structuredClone(w.mainJobs).map((j) => ({ ...j, id: j.id + 10000, run_attempt: 2 }));
      main.run_attempt = 2;
      w.world.attemptJobs.get(main.id).set(2, carried);
      w.world.originalRuns.get(main.id).set(2, structuredClone(main));
      try {
        await expect("certified: positive producer rerun carrying every job (relabelled attempt 2)", () => w.verify(rec, "release"));
        const signed = carried.find((j) => j.name === "signed-build");
        signed.steps[0].started_at = new Date(Date.parse(signed.steps[0].started_at) + 1000).toISOString().replace(".000Z", "Z");
        await expect("certified: signed build re-executed in the later attempt is not the frozen original", () => w.verify(rec, "release"),
          /different execution/);
      } finally {
        Object.assign(main, keepRun); w.world.attemptJobs.get(main.id).delete(2); w.world.originalRuns.get(main.id).delete(2);
      }
      main.conclusion = "failure";
      await expect("certified: producer latest attempt failed", () => w.verify(rec, "release"), /not a successful macos.yml push run/);
      main.conclusion = "success";
      w.state.gate.conclusion = "failure";
      await expect("certified: gate latest attempt failed", () => w.verify(rec, "release"), /merge-gate run .* is completed\/failure/);
      w.state.gate.conclusion = "success";
    }

    // End-of-verify races and metadata.
    {
      const listRoute = `repos/${R}/actions/runs/${PUBLISHER_RUN}/artifacts?per_page=100&page=1`;
      w.reset();
      w.hooks.set(listRoute, (n) => (n === 4 ? { total_count: 2, artifacts: w.artifacts.map((a) => (a.id === decisionArt.id
        ? { ...structuredClone(a), workflow_run: { ...a.workflow_run, head_repository_id: 777777 } } : structuredClone(a))) } : undefined));
      await expect("certified: decision re-attributed in the end listing", () => w.verify(rec, "release"), /is not the publisher run's at/);
      await expect("certified: the end listing was the one mutated", () => { if (w.counters.get(listRoute) !== 4) throw new Error(String(w.counters.get(listRoute))); });
      w.reset();
      const recordRoute = `repos/${R}/actions/artifacts/${decisionArt.id}`;
      w.hooks.set(recordRoute, (n) => (n === 2 ? { ...structuredClone(decisionArt), created_at: "2026-01-01T00:00:00Z" } : undefined));
      await expect("certified: decision record changed at the end", () => w.verify(rec, "release"), /changed between the listing and its record/);
      w.reset();
      const witnessRoute = `repos/${R}/actions/runs/${w.main.id}/artifacts?per_page=100&page=1`;
      let witnessReads = 0;
      w.hooks.set(witnessRoute, (n) => {
        witnessReads = n;
        if (n !== 4) return undefined;
        return { total_count: w.world.artifacts.filter((a) => a.workflow_run.id === w.main.id).length,
          artifacts: w.world.artifacts.filter((a) => a.workflow_run.id === w.main.id).map((a) => (a.name.startsWith("relayium-ci-evidence-witness")
            ? { ...structuredClone(a), workflow_run: { ...a.workflow_run, head_repository_id: 777777 } } : structuredClone(a))) };
      });
      await expect("certified: witness re-attributed in the final chain listing", () => w.verify(rec, "release"),
        /witness artifact .* was replaced, changed or expired|frozen certified coverage no longer holds|is not from run/);
      await expect("certified: the final witness listing was the one mutated", () => { if (witnessReads < 4) throw new Error(String(witnessReads)); });
      w.reset();
      w.hooks.set(`repos/${R}/releases/tags/macos-v1.4.5`, () => { w.state.main = w.sha; return undefined; });
      await expect("certified: main moved during the release verification", () => w.verify(rec, "release"), /main moved while/);
      w.reset();
      w.deliverMain();
    }

    // The source Git adapter: explicit checkout, inherited Git paths ignored, parent required.
    {
      const poison = ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE"];
      const ambient = new Map(poison.map((k) => [k, process.env[k]]));
      process.env.GIT_DIR = join(w.directory, "poison.git");
      process.env.GIT_WORK_TREE = w.directory;
      process.env.GIT_INDEX_FILE = join(w.directory, "poison.index");
      try {
        await expect("certified: source adapter ignores inherited Git paths", () => {
          const head = sourceGitAt(w.checkout)(["rev-parse", "HEAD"]).toString().trim();
          if (head !== w.sha) throw new Error(head);
        });
      } finally { for (const [k, v] of ambient) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } }
      await expect("certified: source adapter refuses an implicit checkout", () => sourceGitAt(""), /explicit checkout/);
      const shallow = join(w.directory, "shallow");
      const clone = spawnSync("git", ["clone", "-q", "--no-local", "--depth", "2", "--branch", "fixture-candidate", `file://${w.checkout}`, shallow],
        { encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } });
      await expect("certified: depth fixture clones the candidate and source only", () => {
        if (clone.status !== 0) throw new Error(clone.stderr);
        const parents = spawnSync("git", ["cat-file", "-e", w.baseSha], { cwd: shallow }).status;
        if (parents === 0) throw new Error("the shallow clone holds the source's parent");
      });
      await expect("certified: a checkout without the signed commit's parent refuses (no rebuild)", () => w.verify(rec, "release", { cwd: shallow }),
        /could not read the signed commit or its parent|frozen certified coverage no longer holds/);
      const full = join(w.directory, "full");
      spawnSync("git", ["clone", "-q", "--no-local", "--branch", "fixture-candidate", `file://${w.checkout}`, full],
        { encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } });
      await expect("certified: positive from an operator's full clone", () => w.verify(rec, "release", { cwd: full }));
      const single = join(w.directory, "single");
      spawnSync("git", ["clone", "-q", "--no-local", "--depth", "1", "--branch", "fixture-candidate", `file://${w.checkout}`, single],
        { encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } });
      await expect("certified: a depth-1 checkout without the signed commit refuses", () => w.verify(rec, "release", { cwd: single }), /failed|could not read/);
      await expect("certified: the explicit adapter refuses a missing signed commit", () => sourceGitAt(single)(["cat-file", "commit", w.sha]),
        /could not read the signed commit or its parent/);
    }

    // The published release, identical.
    w.publishRelease(rec);
    await expect("certified: positive VERIFY release (published identical)", () => w.verify(rec, "release"));
  } finally {
    w.dispose();
  }
}

/**
 * The publish job's executable lines, step by step. Operator mode must not
 * contain a main push, a `gh run watch` or a `gh release create`, and every
 * step that does must be guarded by `metadata_delivery == 'workflow'`.
 */
function workflowControls(failures, pass) {
  const text = readFileSync(join(repoRoot, ".github/workflows/macos-release.yml"), "utf8");
  const ok = (cond, message) => { if (cond) pass(); else failures.push(`workflow: ${message}`); };
  const input = /metadata_delivery:\n(?:\s+.*\n)*?\s+default: operator\n\s+type: choice\n\s+options:\n\s+- operator\n\s+- workflow\n/;
  ok(input.test(text), "metadata_delivery is not a choice input defaulting to operator with exactly operator/workflow");
  const publish = text.slice(text.indexOf("\n  publish:\n"));
  const stepsText = publish.split(/\n      - (?=name:|uses:)/).slice(1);
  const code = (s) => s.split("\n").filter((l) => !/^\s*#/.test(l)).join("\n");
  const writes = [/[^:]:main\b/, /gh run watch/, /gh release create/, /gh release upload/, /git push origin "\$CANDIDATE:main"/];
  for (const step of stepsText) {
    const body = code(step);
    const name = /^name: (.*)$/m.exec(step)?.[1] ?? step.split("\n")[0];
    const guarded = /^\s+if: inputs\.metadata_delivery == 'workflow'$/m.test(body);
    if (writes.some((re) => re.test(body.replace(/ref: main/g, "")))) {
      ok(guarded, `step "${name}" performs a publication write but is not guarded to metadata_delivery == 'workflow'`);
    }
    if (/^\s+if: inputs\.metadata_delivery == 'operator'$/m.test(body)) {
      ok(!writes.some((re) => re.test(body)), `operator step "${name}" reaches a main push, gate wait or release creation`);
    }
  }
  const handoff = stepsText.find((s) => s.startsWith("name: Hand off the frozen candidate"));
  ok(Boolean(handoff), "no operator handoff step");
  ok(handoff && /macos-handoff\.mjs emit/.test(handoff) && /\$GITHUB_STEP_SUMMARY/.test(handoff), "handoff step does not emit the record and summary");
  ok(handoff && /seq 1 24/.test(handoff) && !/gh run watch/.test(handoff), "handoff step waits for the gate rather than only identifying it");
  const guard = stepsText.find((s) => s.startsWith("name: Refuse an unknown metadata delivery mode"));
  ok(guard && /operator\|workflow\) ;;/.test(guard) && /exit 1/.test(guard), "no fail-closed guard for an unknown delivery mode");
  ok(stepsText.findIndex((s) => s.startsWith("name: Refuse an unknown")) < stepsText.findIndex((s) => s.startsWith("name: Assemble")),
    "the delivery-mode guard does not run before assembly");
  ok(/macos-handoff\.mjs workflows-preflight --mode "\$DELIVERY"/.test(text.slice(0, text.indexOf("\n  build:\n"))),
    "preflight does not compare the workflows directory before the paid build");
}

/** The git blob id of `text`, as the contents API reports the bytes it serves. */
const gitBlob = (text) => createHash("sha1").update(`blob ${Buffer.byteLength(text)}\0`).update(text).digest("hex");

/**
 * One merge-gate full-bootstrap dispatch of main at the certified world's
 * commit S, as GitHub-shaped answers layered over `w.api`: the push listing
 * of macos.yml EMPTY; the whole honest gate graph (every lane required); the
 * `macos / ` producer roster executed exactly as a workflow_call leaves it;
 * the aggregate's judged receipt steps; the signed artifact (dispatch
 * provenance) and the aggregate-written receipt; caller and callee through
 * the contents API with the blob of the bytes served. Built from the
 * repository's own roster files and the shipped receipt writer's field list,
 * never from the bootstrap judge's verdicts. `fresh()` restores the honest
 * world; tests change ONE thing in `s`.
 */
export function bootstrapFixture(w, B) {
  const zipOf = storedZip;
  const at = w.now.getTime(), S = w.sha, R = w.repository, RID = w.repositoryId;
  const iso = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
  const BOOT = 36995000900, WF = 9, SIGNED = 11200000900, RECEIPT = 11200000901;
  const ids = { repository: { id: RID, full_name: R, fork: false }, head_repository: { id: RID, full_name: R, fork: false } };
  const runAt = at - 3 * 3600000;
  // The macos lane exactly as the called producer roster reports it.
  const macos = producerRoster({ runId: BOOT, sha: S, start: iso(runAt + 60000), called: true, firstId: 600 })
    .map((j) => ({ ...j, name: j.name.replace(/^build \/ /, "macos / ") }));
  macos.find((j) => j.name === "macos / contract").labels = ["ubuntu-latest"];
  const signedJob = macos.find((j) => j.name === "macos / signed-build");
  const sFrom = Date.parse(signedJob.started_at), sTo = Date.parse(signedJob.completed_at);
  const aggFrom = sTo + 60000;
  const st = (number, name, from, to) => ({ number, name, status: "completed", conclusion: "success", started_at: iso(from), completed_at: iso(to) });
  const aggregate = {
    id: 699, name: "merge-gate", status: "completed", conclusion: "success", run_id: BOOT, head_sha: S, run_attempt: 1,
    labels: ["ubuntu-latest"], runner_name: "GitHub Actions 1699", started_at: iso(aggFrom), completed_at: iso(aggFrom + 60000),
    steps: [st(1, "Set up job", aggFrom, aggFrom + 1000), st(2, B.JUDGE_STEP, aggFrom + 2000, aggFrom + 10000),
      st(3, B.RECORD_STEP, aggFrom + 11000, aggFrom + 12000), st(4, B.KEEP_STEP, aggFrom + 13000, aggFrom + 20000),
      st(5, "Complete job", aggFrom + 59000, aggFrom + 60000)],
  };
  const allLanes = new Set(LANES.map((l) => l.id));
  const others = honestGateJobs(allLanes).filter(([n]) => !n.startsWith("macos / ") && n !== "merge-gate")
    .map(([name, conclusion], i) => ({ id: 400 + i, name, status: "completed", conclusion, run_id: BOOT, head_sha: S, run_attempt: 1 }));
  const honestJobs = () => [...structuredClone(others), ...structuredClone(macos), structuredClone(aggregate)];
  // The signed payload, as the called signed-build uploads it (dispatch provenance).
  const dmg = Buffer.from("synthetic bootstrap signed payload; native signature verified separately");
  const tool = Buffer.from("synthetic generate_appcast");
  const provenance = { ...structuredClone(w.provenance), event: "workflow_dispatch", runId: String(BOOT), runAttempt: "1",
    workflowRef: `${R}/.github/workflows/merge-gate.yml@refs/heads/main`, signedDmgSha256: sha256(dmg), dmgSha256: sha256(dmg),
    generateAppcastSha256: sha256(tool) };
  const signedZip = (p = provenance) => zipOf([{ name: "Relayium.dmg", data: dmg }, { name: "Relayium.dmg.sha256", data: `${sha256(dmg)}  Relayium.dmg\n` },
    { name: "provenance.json", data: JSON.stringify(p) }, { name: "release-tools/generate_appcast", data: tool }]);
  // The receipt, as the canonical record step writes it (its twelve keys).
  const receiptFields = { schema: B.RECEIPT_SCHEMA, mode: B.BOOTSTRAP_MODE, base: S, head: S, sha: S, ref: "refs/heads/main",
    repositoryId: String(RID), runId: String(BOOT), runAttempt: "1", workflowRef: `${R}/.github/workflows/merge-gate.yml@refs/heads/main`,
    workflowSha: S, signedArtifact: `relayium-macos-signed-${S}-ci` };
  const receiptZip = (f = receiptFields) => zipOf([{ name: B.RECEIPT_ENTRY, data: JSON.stringify(f) }]);
  const art = (id, name, bytes, created, expires) => ({ id, node_id: `A${id}`, name, size_in_bytes: bytes.length, expired: false,
    digest: `sha256:${sha256(bytes)}`, created_at: iso(created), updated_at: iso(created), expires_at: iso(expires),
    workflow_run: { id: BOOT, repository_id: RID, head_repository_id: RID, head_branch: "main", head_sha: S } });
  // Mutable per-world state (one object, so holders keep it); `fresh()`
  // resets it to the honest world.
  const s = {};
  const fresh = () => {
    const sz = signedZip(), rz = receiptZip();
    for (const key of Object.keys(s)) delete s[key];
    Object.assign(s, {
      run: { id: BOOT, run_attempt: 1, head_sha: S, head_branch: "main", event: "workflow_dispatch", path: ".github/workflows/merge-gate.yml",
        workflow_id: WF, status: "completed", conclusion: "success", created_at: iso(runAt), run_started_at: iso(runAt), ...ids },
      listed: null, pushRuns: [], jobs: honestJobs(), zips: new Map([[SIGNED, sz], [RECEIPT, rz]]),
      artifacts: [art(SIGNED, `relayium-macos-signed-${S}-ci`, sz, sTo - 30000, at + 7 * 86400000),
        art(RECEIPT, receiptArtifactName(1), rz, aggFrom + 15000, at + 14 * 86400000)],
      callerText: null, workflow: { id: WF, path: ".github/workflows/merge-gate.yml", state: "active" }, late: null, calls: 0, seen: [], calleeText: null,
      onSignedDownload: null,
    });
    w.reset();
  };
  const receiptArtifactName = (n) => `relayium-macos-full-bootstrap-receipt-attempt-${n}`;
  const P = `/repos/${R}`;
  const paged = (key, list) => ({ total_count: list.length, [key]: structuredClone(list) });
  const own = (path) => {
    const u = new URL(`https://fixture.invalid${path}`), p = u.pathname;
    let m;
    s.seen.push(p);
    if (p === `${P}/contents/.github/workflows/macos.yml` && s.calleeText !== null) {
      return { path: ".github/workflows/macos.yml", encoding: "base64", content: Buffer.from(s.calleeText).toString("base64"),
        sha: gitBlob(s.calleeText) };
    }
    if (p === `${P}/actions/workflows/321216057/runs`) return paged("workflow_runs", s.pushRuns);
    if (s.pushRuns.length > 0 && p === `${P}/actions/runs/${s.pushRuns[0].id}`) return structuredClone(s.pushRuns[0]);
    if (p === `${P}/actions/workflows/merge-gate.yml`) return structuredClone(s.workflow);
    if (p === `${P}/actions/workflows/${WF}/runs`) return paged("workflow_runs", s.listed ?? [s.run]);
    if (p === `${P}/actions/runs/${BOOT}`) { s.calls += 1; return structuredClone(s.late && s.calls > s.late.after ? s.late.run(s.run) : s.run); }
    if (p === `${P}/actions/runs/${BOOT}/attempts/${s.run.run_attempt}`) {
      return { id: BOOT, run_attempt: s.run.run_attempt, head_sha: S, status: s.run.status, conclusion: s.run.conclusion,
        path: ".github/workflows/merge-gate.yml" };
    }
    if (p === `${P}/actions/runs/${BOOT}/attempts/${s.run.run_attempt}/jobs`) return paged("jobs", s.jobs);
    if ((m = new RegExp(`^${P}/actions/runs/${BOOT}/attempts/(\\d+)(/jobs)?$`).exec(p)) && s.history?.[m[1]]) {
      const h = s.history[m[1]];
      return m[2] ? paged("jobs", h.jobs) : { id: BOOT, run_attempt: Number(m[1]), head_sha: S, status: "completed", conclusion: h.conclusion,
        path: ".github/workflows/merge-gate.yml" };
    }
    if (p === `${P}/actions/runs/${BOOT}/artifacts`) {
      const list = s.lateArtifacts && s.calls > s.lateArtifacts.after ? s.lateArtifacts.list(s.artifacts) : s.artifacts;
      return paged("artifacts", list.filter((a) => !u.searchParams.has("name") || a.name === u.searchParams.get("name")));
    }
    if ((m = /^\/repos\/[^/]+\/[^/]+\/actions\/artifacts\/(\d+)$/.exec(p)) && s.zips.has(Number(m[1]))) {
      return structuredClone((s.records?.[m[1]]) ?? s.artifacts.find((a) => a.id === Number(m[1])));
    }
    if (p === `${P}/contents/.github/workflows/merge-gate.yml` && u.searchParams.get("ref") === S) {
      const text = s.callerText ?? w.runGit(["show", `${S}:.github/workflows/merge-gate.yml`]).toString();
      return { path: ".github/workflows/merge-gate.yml", encoding: "base64", content: Buffer.from(text).toString("base64"),
        sha: gitBlob(text) };
    }
    return undefined;
  };
  const api = {
    async get(path) { const v = own(path); return v === undefined ? w.api.get(path) : v; },
    async getOptional(path) { try { return await api.get(path); } catch (e) { if (e?.status === 404) return null; throw e; } },
    async download(path) {
      const m = /actions\/artifacts\/(\d+)\/zip$/.exec(path);
      if (m && s.zips.has(Number(m[1]))) {
        const bytes = Buffer.from(s.zips.get(Number(m[1])));
        // A world that moves DURING the slow signed-payload download.
        if (Number(m[1]) === SIGNED && s.onSignedDownload) { const late = s.onSignedDownload; s.onSignedDownload = null; late(); }
        return bytes;
      }
      return w.api.download(path);
    },
  };
  fresh();
  return { at, S, R, RID, iso, BOOT, WF, SIGNED, RECEIPT, ids, runAt, macos, signedJob, sFrom, sTo, aggFrom, aggregate, others,
    dmg, provenance, signedZip, receiptFields, receiptZip, art, s, fresh, receiptArtifactName, P, own, api };
}

// ── the full-bootstrap producer, whole: actual select → decide → readback and
// the historical (H) re-proof, on real Git objects ─────────────────────────
//
// The certified world's checkout supplies the commit S whose merge-gate.yml
// and macos.yml are THIS worktree's files (so the canonical caller/callee the
// judge pins are the ones under review). Its push listing for macos.yml is
// made EMPTY, and one merge-gate dispatch of main at S is served: its whole
// honest gate graph (every lane required), the `macos / ` producer roster
// executed exactly as a workflow_call leaves it, the aggregate's judged
// receipt steps, the signed artifact and the aggregate-written receipt. The
// fixture is built from the repository's own roster files and the shipped
// receipt writer's field list, never from the bootstrap judge's verdicts.
// Every hostile world changes ONE thing and must be refused (or made
// unavailable → build) for its own reason after the positive passed.
export async function bootstrapCases(expect) {
  const E = await import("../release/macos-evidence.mjs");
  const B = await import("../release/macos-bootstrap.mjs");
  const { certifiedWorld } = await import("./fixtures/macos-certified/world.mjs");
  const w = await certifiedWorld();
  try {
    const F = bootstrapFixture(w, B);
    const { at, S, R, RID, iso, BOOT, WF, SIGNED, RECEIPT, ids, macos, signedJob, aggFrom, aggregate, others, dmg, provenance,
      signedZip, receiptFields, receiptZip, s, fresh, receiptArtifactName, P, api } = F;
    let seq = 0;
    const opts = (mode, extra = {}) => ({ mode, repository: R, repositoryId: RID, sha: S, ref: "refs/heads/main", releaseVersion: "",
      now: at, dir: join(w.directory, `boot-${++seq}`), ...extra });
    const decideIn = (mode, extra) => w.inCheckout(() => decide(api, opts(mode, extra)));
    const historical = (ev, clock = () => at) => w.inCheckout(() => B.verifyBootstrapProducer(api, { repository: R, repositoryId: RID, sha: S,
      runId: ev.run.id, workflowId: ev.producer.caller.id, originalAttempt: ev.signedBuildOrigin.attempt, cwd: w.checkout, clock }));

    // ── positive: the whole new route ──
    fresh();
    let frozen;
    await expect("bootstrap: positive AUTO select chooses reuse of the full-bootstrap producer", async () => {
      const d = await decideIn("auto");
      if (d.source !== "reuse") throw new Error(`chose ${d.source}: ${d.reason}`);
      const ev = d.evidence;
      if (ev.schema !== E.EVIDENCE_SCHEMA_V3 || ev.producer?.kind !== E.BOOTSTRAP_KIND || ev.run.id !== BOOT
        || ev.run.event !== "workflow_dispatch" || ev.coverage.mode !== E.COVERAGE_EXECUTED) throw new Error(`froze ${JSON.stringify(ev).slice(0, 300)}`);
      if (ev.producer.receipt.identity.id !== RECEIPT || ev.artifact.id !== SIGNED || ev.signedBuildOrigin.jobId !== signedJob.id) {
        throw new Error("the decision does not bind the receipt, the signed artifact and the signed-build execution");
      }
      frozen = ev;
    });
    fresh();
    await expect("bootstrap: positive forced reuse freezes the same identity", async () => {
      const d = await decideIn("reuse");
      if (!frozen || E.evidenceIdentity(d.evidence) !== E.evidenceIdentity(frozen)) throw new Error("different identity");
    });
    fresh();
    await expect("bootstrap: positive readback re-proves the frozen identity and installs the payload", async () => {
      const dir = join(w.directory, "boot-readback");
      const back = await w.inCheckout(() => readback(api, frozen, { now: at + 600000, dir, releaseVersion: "" }));
      if (E.evidenceIdentity(back) !== E.evidenceIdentity(frozen)) throw new Error("readback identity differs");
      if (sha256(readFileSync(join(dir, "Relayium.dmg"))) !== sha256(dmg)) throw new Error("payload not installed");
    });
    fresh();
    await expect("bootstrap: positive H historical re-proof binds the frozen producer", async () => {
      const p = await historical(frozen);
      if (p.callerBlob !== frozen.producer.caller.blob || p.aggregate !== frozen.producer.aggregate
        || p.inventory !== frozen.producer.inventory || p.receipt.identity.id !== RECEIPT
        || sha256(Buffer.from(p.origin.identity)) !== frozen.signedBuildOrigin.execution) throw new Error("re-proof differs from the decision");
    });
    fresh();
    await expect("bootstrap: H stays verifiable after the selection window (no freshening)", async () => {
      s.run.created_at = iso(at - 400 * 3600000); s.run.run_started_at = s.run.created_at;
      await historical(frozen, () => at + 6 * 86400000);
    });

    // ── unavailable → build (never a silent reuse, never hiding a red push) ──
    const toBuild = async (label, mutate, reason) => {
      fresh(); mutate();
      await expect(label, async () => {
        const d = await decideIn("auto");
        if (d.source !== "build" || !reason.test(d.reason)) throw new Refused(`auto chose ${d.source}: ${d.reason}`);
        throw new Refused(`build: ${d.reason}`);
      }, reason);
    };
    const pushRun = (status, conclusion) => ({ id: 36995000777, run_attempt: 1, head_sha: S, head_branch: "main", event: "push",
      path: ".github/workflows/macos.yml", workflow_id: 321216057, status, conclusion, created_at: iso(at - 3600000), ...ids });
    for (const [label, st2, c] of [["failed", "completed", "failure"], ["pending", "in_progress", null], ["cancelled", "completed", "cancelled"]]) {
      fresh(); s.pushRuns = [pushRun(st2, c)];
      await expect(`bootstrap: an existing ${label} push run keeps the push path (never bootstrap)`, async () => {
        let d, err;
        try { d = await decideIn("auto"); } catch (e) { err = e; }
        if (d?.source === "reuse" && d.evidence?.producer?.kind === E.BOOTSTRAP_KIND) throw new Error("a bootstrap hid the push run");
        if (d?.source === "reuse") throw new Error("reused a non-green push run");
        if (s.seen.some((c2) => c2.includes("merge-gate.yml") || c2.includes(`${BOOT}`))) throw new Error("consulted the bootstrap producer");
        // The push path judged the push run itself and stopped there.
        if (!s.seen.includes(`${P}/actions/runs/36995000777`)) throw new Error(`push run not judged: ${d?.reason ?? err?.message}`);
        if (d?.source !== "build" || !/36995000777/.test(d.reason)) throw new Error(`not a push-path build: ${d?.source}/${d?.reason ?? err?.message}`);
        throw new Refused(`push path kept: ${d?.reason ?? err?.message}`);
      }, /push path kept/);
    }
    await toBuild("bootstrap: no dispatch at all", () => { s.listed = []; }, /no merge-gate run was dispatched/);
    await toBuild("bootstrap: two dispatches are ambiguous", () => { s.listed = [s.run, { ...s.run, id: BOOT + 1 }]; }, /2 merge-gate runs were dispatched/);
    await toBuild("bootstrap: latest attempt failed", () => { s.run.conclusion = "failure"; }, /concluded failure/);
    await toBuild("bootstrap: latest attempt pending", () => { s.run.status = "in_progress"; s.run.conclusion = null; }, /pending attempt/);
    await toBuild("bootstrap: older than the selection age", () => { s.run.created_at = iso(at - 200 * 3600000); s.run.run_started_at = s.run.created_at; }, /older than 168/);
    await toBuild("bootstrap: future run", () => { s.run.created_at = iso(at + 3600000); }, /not yet started/);
    await toBuild("bootstrap: no receipt (mode unproven)", () => { s.artifacts = s.artifacts.filter((a) => a.id !== RECEIPT); }, /carries no full-bootstrap receipt/);
    await toBuild("bootstrap: two receipts", () => { s.artifacts.push({ ...s.artifacts[1], id: RECEIPT + 5 }); }, /2 full-bootstrap receipts/);
    await toBuild("bootstrap: receipt expires inside the margin", () => { s.artifacts[1].expires_at = iso(at + 3600000); }, /expires in under 6 hours/);
    await toBuild("bootstrap: caller lacks the receipt steps (97fd-style retro)", () => {
      s.callerText = w.runGit(["show", `${S}:.github/workflows/merge-gate.yml`]).toString().split(`      - name: ${B.RECORD_STEP}`)[0];
    }, /not a full-bootstrap caller/);
    await toBuild("bootstrap: macos caller gains inputs", () => {
      s.callerText = w.runGit(["show", `${S}:.github/workflows/merge-gate.yml`]).toString()
        .replace("    uses: ./.github/workflows/macos.yml\n", "    uses: ./.github/workflows/macos.yml\n    with:\n      release_version: '9.9.9'\n");
    }, /macos caller is not exactly the canonical call/);
    await toBuild("bootstrap: callee default inputs changed (notarize default true)", () => {
      s.calleeText = w.runGit(["show", `${S}:.github/workflows/macos.yml`]).toString()
        .replace(/( {6}notarize:\n(?: {8}description:.*\n)? {8}required: false\n {8}default: )false/, "$1true");
      if (!s.calleeText.includes("default: true")) throw new Error("callee control could not be applied");
    }, /is not the callee a full bootstrap runs: its workflow_call inputs/);
    await toBuild("bootstrap: run of another workflow id", () => { s.run.workflow_id = WF + 1; }, /is not a same-repository main dispatch/);
    await toBuild("bootstrap: run on another branch", () => { s.run.head_branch = "feature"; }, /is not a same-repository main dispatch/);
    await toBuild("bootstrap: run in another repository id", () => { s.run.repository = { ...s.run.repository, id: 1 }; }, /is not a same-repository main dispatch/);
    await toBuild("bootstrap: merge-gate workflow disabled", () => { s.workflow.state = "disabled_manually"; }, /not active/);
    await toBuild("bootstrap: missing required lane job", () => { s.jobs = s.jobs.filter((j) => j.name !== "go / evidence" && j.name !== others[1].name); },
      /lacks required job|outside|executes every job|reads as|roster/);
    await toBuild("bootstrap: partial UI (one ui-smoke shard missing)", () => {
      s.jobs = s.jobs.filter((j) => !(j.name.startsWith("macos / ui-smoke") && j.name.includes("device-inbox")));
    }, /ui-smoke|roster|missing|lacks/);

    // ── refused: the run claims to be a full bootstrap and disagrees ──
    const refused = async (label, mutate, reason) => {
      fresh(); mutate();
      await expect(label, () => decideIn("reuse"), reason);
    };
    for (const [key, value] of [["mode", "pull-request"], ["base", "f".repeat(40)], ["head", "f".repeat(40)], ["sha", "f".repeat(40)],
      ["ref", "refs/heads/other"], ["repositoryId", "1"], ["runId", "1"], ["runAttempt", "2"],
      ["workflowRef", `${R}/.github/workflows/merge-gate.yml@refs/heads/other`], ["workflowSha", "f".repeat(40)],
      ["signedArtifact", "relayium-macos-signed-other-ci"], ["schema", "relayium-macos-full-bootstrap-receipt/v0"]]) {
      await refused(`bootstrap: receipt.${key} wrong`, () => {
        const rz = receiptZip({ ...receiptFields, [key]: value });
        s.zips.set(RECEIPT, rz); Object.assign(s.artifacts[1], { digest: `sha256:${sha256(rz)}`, size_in_bytes: rz.length });
      }, new RegExp(`receipt\\.${key} is`));
    }
    await refused("bootstrap: receipt has an extra key", () => {
      const rz = receiptZip({ ...receiptFields, extra: "x" });
      s.zips.set(RECEIPT, rz); Object.assign(s.artifacts[1], { digest: `sha256:${sha256(rz)}`, size_in_bytes: rz.length });
    }, /has keys/);
    await refused("bootstrap: receipt bytes are not the API digest", () => { s.zips.set(RECEIPT, receiptZip({ ...receiptFields })); s.artifacts[1].digest = `sha256:${"0".repeat(64)}`; },
      /API digest/);
    await refused("bootstrap: receipt created outside the aggregate's keep step", () => { s.artifacts[1].created_at = iso(aggFrom + 40000); }, /outside .*Keep the full-bootstrap/);
    await refused("bootstrap: receipt of another attempt", () => { s.artifacts[1].name = receiptArtifactName(2); }, /receipt is of attempt 2/);
    await refused("bootstrap: receipt record differs from listing", () => { s.records = { [RECEIPT]: { ...s.artifacts[1], digest: `sha256:${"1".repeat(64)}` } }; },
      /changed between the listing and its record/);
    await refused("bootstrap: receipt of another run", () => { s.artifacts[1].workflow_run = { ...s.artifacts[1].workflow_run, id: BOOT + 1 }; },
      /is not an artifact of merge-gate run/);
    await refused("bootstrap: aggregate recorded before judging", () => {
      const a = s.jobs.find((j) => j.name === "merge-gate");
      [a.steps[1].name, a.steps[2].name] = [a.steps[2].name, a.steps[1].name];
    }, /in that order/);
    await refused("bootstrap: duplicate aggregate", () => { s.jobs.push({ ...structuredClone(aggregate), id: 698 }); }, /lists 2 merge-gate job/);
    await refused("bootstrap: extra unknown job in the caller", () => { s.jobs.push({ id: 697, name: "rogue", status: "completed", conclusion: "success", run_id: BOOT, head_sha: S, run_attempt: 1 }); },
      /outside the base-owned roster/);
    await refused("bootstrap: duplicate lane job", () => { s.jobs.push({ ...structuredClone(others[1]), id: 696 }); }, /more than once/);
    const requiredCheck = others.find((j) => j.conclusion === "success" && j.name.includes(" / ") && !j.name.endsWith(" / evidence"));
    await refused(`bootstrap: skipped required lane job (${requiredCheck.name})`, () => { s.jobs.find((j) => j.name === requiredCheck.name).conclusion = "skipped"; },
      /concluded skipped; the base roster requires/);
    await toBuild("bootstrap: UI shards witnessed instead of executed", () => {
      for (const j of s.jobs.filter((x) => x.name.startsWith("macos / ui-smoke") || x.name === "macos / test")) {
        for (const step of j.steps) {
          if (WITNESS_STEPS.includes(step.name)) Object.assign(step, { conclusion: "success", started_at: j.started_at, completed_at: j.started_at });
          else if (REQUIRED_STEPS[j.name.includes("app-shell") ? "ui-smoke/app-shell" : j.name.includes("device-inbox") ? "ui-smoke/device-inbox" : "test"]
            .includes(step.name)) Object.assign(step, { conclusion: "skipped", started_at: null, completed_at: null });
        }
      }
    }, /witness|executes every job|coverage/);
    await refused("bootstrap: rerun attempt 2 re-executed signed-build (provenance names attempt 1)", () => {
      const original = structuredClone(s.jobs);
      s.history = { 1: { jobs: original, conclusion: "failure" } };
      s.run.run_attempt = 2;
      s.jobs = s.jobs.map((j) => ({ ...j, run_attempt: 2 }));
      const sj = s.jobs.find((j) => j.name === "macos / signed-build");
      sj.started_at = iso(Date.parse(sj.started_at) + 1000);
      const rz = receiptZip({ ...receiptFields, runAttempt: "2" });
      s.zips.set(RECEIPT, rz);
      Object.assign(s.artifacts[1], { name: receiptArtifactName(2), digest: `sha256:${sha256(rz)}`, size_in_bytes: rz.length });
    }, /signed-build/);
    await refused("bootstrap: provenance carries a release version", () => {
      const sz = signedZip({ ...provenance, releaseVersion: "1.4.6" });
      s.zips.set(SIGNED, sz); Object.assign(s.artifacts[0], { digest: `sha256:${sha256(sz)}`, size_in_bytes: sz.length });
    }, /releaseVersion/);
    await refused("bootstrap: provenance claims push (wrong tuple)", () => {
      const sz = signedZip({ ...provenance, event: "push" });
      s.zips.set(SIGNED, sz); Object.assign(s.artifacts[0], { digest: `sha256:${sha256(sz)}`, size_in_bytes: sz.length });
    }, /event/);
    await refused("bootstrap: provenance workflowRef names macos.yml", () => {
      const sz = signedZip({ ...provenance, workflowRef: `${R}/.github/workflows/macos.yml@refs/heads/main` });
      s.zips.set(SIGNED, sz); Object.assign(s.artifacts[0], { digest: `sha256:${sha256(sz)}`, size_in_bytes: sz.length });
    }, /workflowRef/);
    await refused("bootstrap: run record from a fork", () => { s.run.head_repository = { id: 1, full_name: "evil/relayium", fork: true }; }, /changed identity|not a same-repository/);
    // ── the end anchor: the world moves DURING the slow signed download, with
    // the run record and the signed artifact's identity unchanged; the whole
    // producer is judged again and each change is refused for its own part ──
    const late = async (label, change, reason) => {
      fresh();
      let fired = false;
      s.onSignedDownload = () => { fired = true; change(); };
      await expect(label, async () => {
        try { await decideIn("reuse"); } finally { if (!fired) throw new Error("control not triggered: no signed download"); }
      }, reason);
    };
    const moved = (part) => new RegExp(`merge-gate run ${BOOT} changed while the evidence was being collected: ${part}`);
    await late("bootstrap end: receipt replaced (same values, other identity)", () => {
      s.artifacts[1] = { ...s.artifacts[1], id: RECEIPT + 9 }; s.zips.set(RECEIPT + 9, s.zips.get(RECEIPT));
    }, moved("its receipt is not the one judged"));
    await late("bootstrap end: receipt bytes and digest re-written under the same id", () => {
      const rz = storedZip([{ name: B.RECEIPT_ENTRY, data: `${JSON.stringify(receiptFields, null, 1)}\n` }]);
      s.zips.set(RECEIPT, rz); Object.assign(s.artifacts[1], { digest: `sha256:${sha256(rz)}`, size_in_bytes: rz.length });
    }, moved("its receipt is not the one judged"));
    await late("bootstrap end: a lane job substituted (job inventory)", () => {
      s.jobs.find((j) => j.name === requiredCheck.name).id = 12345;
    }, moved("its job inventory is not the one judged"));
    await late("bootstrap end: a lane job's steps re-written (job executions)", () => {
      const j = s.jobs.find((x) => x.name === requiredCheck.name);
      j.steps = [{ number: 1, name: "Set up job", status: "completed", conclusion: "success", started_at: iso(at - 7200000), completed_at: iso(at - 7190000) }];
    }, moved("its job executions is not the one judged"));
    await late("bootstrap end: an extra job appears", () => {
      s.jobs.push({ id: 697, name: "rogue", status: "completed", conclusion: "success", run_id: BOOT, head_sha: S, run_attempt: 1 });
    }, moved(".*outside the base-owned roster"));
    await late("bootstrap end: aggregate's original execution re-written", () => {
      const a = s.jobs.find((x) => x.name === "merge-gate"); a.steps[4].completed_at = iso(Date.parse(a.steps[4].completed_at) + 1000);
    }, moved("its aggregate execution is not the one judged"));
    await late("bootstrap end: aggregate's keep step moved off the receipt", () => {
      const a = s.jobs.find((x) => x.name === "merge-gate");
      Object.assign(a.steps[3], { started_at: iso(aggFrom + 30000), completed_at: iso(aggFrom + 40000) });
    }, moved(".*outside .*Keep the full-bootstrap"));
    await late("bootstrap end: signed-build times re-written", () => {
      const j = s.jobs.find((x) => x.name === "macos / signed-build"); j.completed_at = iso(Date.parse(j.completed_at) + 1000);
    }, moved("its (job executions|signed-build original execution) is not the one judged"));
    await late("bootstrap end: signed-build steps re-written", () => {
      const j = s.jobs.find((x) => x.name === "macos / signed-build"); j.steps[j.steps.length - 1].name = "Renamed";
    }, moved(".*signed-build|its job executions is not the one judged"));
    await late("bootstrap end: caller source blob substituted (still canonical)", () => {
      s.callerText = `# substituted\n${w.runGit(["show", `${S}:.github/workflows/merge-gate.yml`]).toString()}`;
    }, moved(`the checkout's .github/workflows/merge-gate.yml at ${S} is [0-9a-f]{40}, not the API's`));
    await late("bootstrap end: callee source blob substituted (same shape)", () => {
      s.calleeText = `# substituted\n${w.runGit(["show", `${S}:.github/workflows/macos.yml`]).toString()}`;
    }, moved("its callee is not the one judged"));
    await late("bootstrap end: latest attempt failed", () => { s.run.conclusion = "failure"; },
      moved("merge-gate run \\d+ is no longer a successful dispatch on main"));
    await late("bootstrap end: an unrelated artifact appears (whole artifact list)", () => {
      s.artifacts.push({ ...s.artifacts[0], id: SIGNED + 50, name: "other-artifact" });
    }, moved("its run record or artifact list is not the one judged"));

    // ── historical H refusals: the producer moved after the decision ──
    // What macos-handoff.mjs's verify binds after the shared judge returns.
    const hBind = async () => {
      const p = await historical(frozen);
      if (sha256(Buffer.from(p.origin.identity)) !== frozen.signedBuildOrigin.execution || p.origin.job.id !== frozen.signedBuildOrigin.jobId) {
        throw new Refused("the reused signed-build execution is not the one the decision froze");
      }
      if (p.callerBlob !== frozen.producer.caller.blob || p.aggregate !== frozen.producer.aggregate || p.inventory !== frozen.producer.inventory
        || JSON.stringify(p.receipt) !== JSON.stringify(frozen.producer.receipt)) {
        throw new Refused("the full-bootstrap caller, receipt, aggregate or inventory read back now is not the one the decision froze");
      }
      return p;
    };
    const hRefused = async (label, mutate, reason) => {
      fresh(); mutate();
      await expect(label, hBind, reason);
    };
    await hRefused("bootstrap H: latest attempt now failed", () => { s.run.conclusion = "failure"; }, /not a successful merge-gate\.yml dispatch/);
    await hRefused("bootstrap H: receipt expired at the machine clock", () => { s.artifacts[1].expires_at = iso(at - 1000); s.artifacts[1].expired = false; }, /expired at/);
    await hRefused("bootstrap H: receipt gone", () => { s.artifacts = s.artifacts.filter((a) => a.id !== RECEIPT); }, /is not a proved signed build: .*no full-bootstrap receipt/);
    await hRefused("bootstrap H: signed-build execution changed", () => {
      const j = s.jobs.find((x) => x.name === "macos / signed-build"); j.started_at = iso(Date.parse(j.started_at) - 1000);
    }, /signed-build execution is not the one the decision froze/);
    await hRefused("bootstrap H: aggregate execution changed", () => {
      const a = s.jobs.find((x) => x.name === "merge-gate"); a.steps[3].completed_at = iso(Date.parse(a.steps[3].completed_at) + 1000);
    }, /caller, receipt, aggregate or inventory/);
    await hRefused("bootstrap H: job inventory changed (a lane job relabelled)", () => {
      s.jobs.find((x) => x.name === requiredCheck.name).id = 12345;
    }, /caller, receipt, aggregate or inventory/);
    await hRefused("bootstrap H: new receipt same values other identity", () => {
      s.artifacts[1] = { ...s.artifacts[1], id: RECEIPT + 7 }; s.zips.set(RECEIPT + 7, s.zips.get(RECEIPT));
    }, /caller, receipt, aggregate or inventory/);
    fresh();
    await expect("bootstrap H: positive bound re-proof", hBind);
  } finally {
    w.dispose();
  }
}

// ── the full-bootstrap producer through the WHOLE publisher world ───────────
//
// `handoffWorld` with the bootstrap dispatch layered under it: the publisher
// preflight's ACTUAL `decide` (AUTO) selects the bootstrap producer, the
// notarize stage's ACTUAL `readback` re-proves it, the notarized provenance
// names it, and the decision ZIP, frozen metadata candidate, gate and release
// surfaces are the certified world's. Then the shipped `emitHandoff` writes the
// v3 record, the shipped strict `parseHandoff` reads it, and the shipped
// `verifyHandoff` stages main and release re-prove it. Every refusal below
// reaches that real entrypoint and is matched by its own reason.
export async function bootstrapHandoffCases(expect) {
  const E = await import("../release/macos-evidence.mjs");
  const B = await import("../release/macos-bootstrap.mjs");
  const H = await import("../release/macos-handoff.mjs");
  const layer = (setup) => (world) => {
    const F = bootstrapFixture(world, B);
    if (setup) setup(F);
    return { F, api: F.api, provenance: F.provenance, dmgSha256: sha256(F.dmg),
      check(ev) {
        if (ev.schema !== E.EVIDENCE_SCHEMA_V3 || ev.producer?.kind !== E.BOOTSTRAP_KIND || ev.run.id !== F.BOOT
          || ev.coverage.mode !== E.COVERAGE_EXECUTED) throw new Error(`the preflight did not select the full bootstrap: ${JSON.stringify(ev).slice(0, 200)}`);
      } };
  };
  // Through the strict parser, then the real verify.
  const V = (w, rec, stage, extra) => w.verify(parseHandoff(JSON.stringify(rec)), stage, extra);
  const w = await handoffWorld({ gateJobs: honestGateJobs, mode: "auto", producer: layer() });
  const { F } = w.layer;
  const { s, at, S, BOOT, SIGNED, RECEIPT, iso, others, receiptFields } = F;
  const raw = (rec) => JSON.parse(JSON.stringify(rec));
  try {
    let rec;
    await expect("bootstrap handoff: positive EMIT writes a v3 main-full-bootstrap record", async () => {
      rec = await w.emit();
      const sb = rec.signedBuild, ev = w.decisionRecord.evidence;
      const decisionArt = w.artifacts.find((a) => a.name.includes("build-source"));
      const bad = [];
      if (rec.schema !== H.HANDOFF_SCHEMA_V3 || sb.kind !== E.BOOTSTRAP_KIND || sb.runId !== BOOT) bad.push("schema/kind/run");
      if (sb.coverage.mode !== E.COVERAGE_EXECUTED || sb.originalAttempt !== 1 || sb.execution !== ev.signedBuildOrigin.execution) bad.push("origin");
      if (JSON.stringify(sb.producer) !== JSON.stringify(ev.producer) || sb.producer.receipt.identity.id !== RECEIPT) bad.push("producer");
      if (JSON.stringify(sb.decision.identity) !== JSON.stringify(artifactIdentityOf(decisionArt)) || sb.decision.mode !== "auto") bad.push("decision");
      if (sb.signedArtifact.id !== SIGNED) bad.push("signed artifact");
      if (bad.length) throw new Error(bad.join(", "));
    });
    // Without the positive record every later control would be vacuous.
    if (!rec) return;
    await expect("bootstrap handoff: the strict parser reads the v3 record back exactly", () => {
      if (JSON.stringify(parseHandoff(JSON.stringify(rec))) !== JSON.stringify(rec)) throw new Error("parse changed the record");
    });
    await expect("bootstrap handoff: positive VERIFY main re-proves the producer historically (no new selection)", async () => {
      w.reset();
      await V(w, rec, "main");
      const selection = w.calls.filter((c) => c.includes("actions/workflows/321216057/runs") || c.endsWith("actions/workflows/macos.yml")
        || (c.includes("actions/workflows/9/runs") && c.includes(`head_sha=${S}`) && c.includes("branch=main&") && !c.includes("event=workflow_dispatch&branch=main&head_sha")));
      if (selection.length) throw new Error(`verify ran a selection read: ${selection.join(", ")}`);
      for (const need of [`repos/${w.repository}/actions/runs/${BOOT}`, `repos/${w.repository}/actions/artifacts/${RECEIPT}`,
        `DOWNLOAD repos/${w.repository}/actions/artifacts/${RECEIPT}/zip`]) {
        if (!w.calls.includes(need)) throw new Error(`verify did not re-read ${need}`);
      }
    });

    // Schema substitution at the real parser.
    await expect("bootstrap handoff: v3 record relabelled v2 is refused", () => V(w, { ...raw(rec), schema: HANDOFF_SCHEMA }, "main"),
      /handoff signedBuild has keys \[.*producer.*\]; the schema requires exactly/);
    await expect("bootstrap handoff: v2 form of a bootstrap chain (producer dropped) is refused", () => {
      const r = raw(rec); r.schema = HANDOFF_SCHEMA; delete r.signedBuild.producer;
      return V(w, r, "main");
    }, /handoff signedBuild\.kind "main-full-bootstrap" is unknown$/);
    await expect("bootstrap handoff: v3 record claiming a main-push kind is refused", () => {
      const r = raw(rec); r.signedBuild.kind = "main-push";
      return V(w, r, "main");
    }, /handoff signedBuild\.kind "main-push" is unknown to relayium-macos-publication-handoff\/v3/);
    await expect("bootstrap handoff: v3 record without its producer is refused", () => {
      const r = raw(rec); delete r.signedBuild.producer;
      return V(w, r, "main");
    }, /handoff signedBuild has keys .*; the schema requires exactly \[.*producer/);
    await expect("bootstrap handoff: v1 form is refused (never inferred)", () => w.verify(asV1(rec), "main"),
      new RegExp(`the reused producer run ${BOOT} is not a successful macos\\.yml push run on main at ${S}`));
    // The record's frozen producer, edited: the real chain no longer matches it.
    await expect("bootstrap handoff: record producer aggregate edited", () => {
      const r = raw(rec); r.signedBuild.producer.aggregate = "0".repeat(64);
      return V(w, r, "main");
    }, /the signed-build chain read back now differs from the chain the handoff froze/);
    await expect("bootstrap handoff: record receipt identity edited", () => {
      const r = raw(rec); r.signedBuild.producer.receipt.identity.digest = `sha256:${"1".repeat(64)}`;
      return V(w, r, "main");
    }, /the signed-build chain read back now differs from the chain the handoff froze/);

    // The producer moved after the decision: each is refused by the real verify.
    const moved = async (label, change, reason) => {
      F.fresh(); change();
      try { await expect(label, () => V(w, rec, "main"), reason); } finally { F.fresh(); }
    };
    const what = `the full-bootstrap producer run ${BOOT}`;
    const requiredCheck = others.find((j) => j.conclusion === "success" && j.name.includes(" / ") && !j.name.endsWith(" / evidence"));
    await moved("bootstrap handoff: receipt gone", () => { s.artifacts = s.artifacts.filter((a) => a.id !== RECEIPT); },
      new RegExp(`${what} is not a proved signed build: .*carries no full-bootstrap receipt`));
    await moved("bootstrap handoff: receipt replaced (same values, other identity)", () => {
      s.artifacts[1] = { ...s.artifacts[1], id: RECEIPT + 7 }; s.zips.set(RECEIPT + 7, s.zips.get(RECEIPT));
    }, /the full-bootstrap caller, receipt, aggregate or inventory read back now is not the one the decision froze/);
    await moved("bootstrap handoff: receipt bytes and digest re-written under the same id", () => {
      const rz = storedZip([{ name: B.RECEIPT_ENTRY, data: `${JSON.stringify(receiptFields, null, 1)}\n` }]);
      s.zips.set(RECEIPT, rz); Object.assign(s.artifacts[1], { digest: `sha256:${sha256(rz)}`, size_in_bytes: rz.length });
    }, /the full-bootstrap caller, receipt, aggregate or inventory read back now is not the one the decision froze/);
    await moved("bootstrap handoff: receipt field wrong (mode)", () => {
      const rz = storedZip([{ name: B.RECEIPT_ENTRY, data: JSON.stringify({ ...receiptFields, mode: "pull-request" }) }]);
      s.zips.set(RECEIPT, rz); Object.assign(s.artifacts[1], { digest: `sha256:${sha256(rz)}`, size_in_bytes: rz.length });
    }, new RegExp(`${what}: receipt\\.mode is "pull-request"`));
    await moved("bootstrap handoff: caller source blob substituted (still canonical)", () => {
      s.callerText = `# substituted\n${w.runGit(["show", `${S}:.github/workflows/merge-gate.yml`]).toString()}`;
    }, new RegExp(`${what}: the checkout's \\.github/workflows/merge-gate\\.yml at ${S} is [0-9a-f]{40}, not the API's`));
    await moved("bootstrap handoff: caller no longer canonical", () => {
      s.callerText = w.runGit(["show", `${S}:.github/workflows/merge-gate.yml`]).toString().split(`      - name: ${B.RECORD_STEP}`)[0];
    }, new RegExp(`${what} is not a proved signed build: .*is not a full-bootstrap caller`));
    await moved("bootstrap handoff: callee source blob substituted (same shape)", () => {
      s.calleeText = `# substituted\n${w.runGit(["show", `${S}:.github/workflows/macos.yml`]).toString()}`;
    }, /the producer workflow at the source is not the one the decision froze/);
    await moved("bootstrap handoff: aggregate execution changed", () => {
      const a = s.jobs.find((x) => x.name === "merge-gate"); a.steps[4].completed_at = iso(Date.parse(a.steps[4].completed_at) + 1000);
    }, /the full-bootstrap caller, receipt, aggregate or inventory read back now is not the one the decision froze/);
    await moved("bootstrap handoff: whole job inventory changed", () => { s.jobs.find((x) => x.name === requiredCheck.name).id = 12345; },
      /the full-bootstrap caller, receipt, aggregate or inventory read back now is not the one the decision froze/);
    await moved("bootstrap handoff: a required lane job now skipped", () => { s.jobs.find((x) => x.name === requiredCheck.name).conclusion = "skipped"; },
      new RegExp(`${what}: .*concluded skipped; the base roster requires`));
    await moved("bootstrap handoff: original signed-build execution changed", () => {
      const j = s.jobs.find((x) => x.name === "macos / signed-build"); j.started_at = iso(Date.parse(j.started_at) - 1000);
    }, /the reused signed-build execution is not the one the decision froze/);
    await moved("bootstrap handoff: latest attempt now failed", () => { s.run.conclusion = "failure"; },
      new RegExp(`${what} is not a successful merge-gate\\.yml dispatch on main`));
    {
      const decision = w.artifacts.find((a) => a.name.includes("build-source"));
      const saved = [structuredClone(decision), w.zips.get(decision.id)];
      const record = structuredClone(w.decisionRecord);
      record.evidence.producer.aggregate = "2".repeat(64);
      const bytes = storedZip([{ name: "reuse-decision.json", data: `${JSON.stringify(record, null, 2)}\n` }]);
      w.zips.set(decision.id, bytes); Object.assign(decision, { digest: `sha256:${sha256(bytes)}`, size_in_bytes: bytes.length });
      try {
        await expect("bootstrap handoff: decision ZIP replaced (producer edited, digest consistent)", () => V(w, rec, "main"),
          new RegExp(`decision artifact ${decision.id} is not the frozen decision ${decision.id} \\(replaced or changed\\)`));
      } finally { Object.assign(decision, saved[0]); w.zips.set(decision.id, saved[1]); }
    }
    await expect("bootstrap handoff: positive VERIFY main again after the controls (world restored)", () => V(w, rec, "main"));

    // Release stage, expiry and freshness.
    w.deliverMain();
    await expect("bootstrap handoff: positive VERIFY release (tag absent)", () => V(w, rec, "release"));
    const until = H.verifiableUntil(rec);
    await expect("bootstrap handoff: verifiableUntil is the receipt's expiry (earliest retained)", () => {
      if (until !== rec.signedBuild.producer.receipt.identity.expires_at) throw new Error(`${until}`);
      if (!handoffSummary(rec).includes(`receipt ${RECEIPT}`)) throw new Error("summary does not name the receipt");
    });
    const later = at + 8 * 86400000;
    await expect("bootstrap handoff: no freshening — release verifies with the producer run older than 168h", () => V(w, rec, "release", { clock: () => later }));
    await expect("bootstrap handoff: ... while a NEW auto selection at that instant rebuilds", async () => {
      const d = await w.inCheckout(() => decide(F.api, { mode: "auto", repository: w.repository, repositoryId: w.repositoryId, sha: S,
        ref: "refs/heads/main", releaseVersion: "1.4.5", now: later, dir: join(w.directory, "boot-later-auto") }));
      if (d.source !== "build" || !/older than 168 hours/.test(d.reason)) throw new Error(`${d.source}: ${d.reason}`);
    });
    await expect("bootstrap handoff: positive just before verifiableUntil", () => V(w, rec, "release", { clock: () => Date.parse(until) - 60000 }));
    await expect("bootstrap handoff: refused once the receipt has expired", () => V(w, rec, "release", { clock: () => Date.parse(until) + 1000 }),
      /expired/);
    {
      const branchRoute = `repos/${w.repository}/git/ref/heads/${w.branchName}`;
      w.reset();
      let now = at;
      w.hooks.set(branchRoute, (n) => { if (n === 2) now = Date.parse(until) + 1000; return undefined; });
      await expect("bootstrap handoff: the receipt expires at the END of verify", async () => {
        try { await V(w, rec, "release", { clock: () => now }); } finally {
          if (w.counters.get(branchRoute) !== 2 || !(now > Date.parse(until))) throw new Error(`control not triggered: ${w.counters.get(branchRoute)}`);
        }
      }, /the retained chain expired at .* before the handoff verification finished/);
      w.reset();
    }
    w.publishRelease(rec);
    await expect("bootstrap handoff: positive VERIFY release (published identical)", () => V(w, rec, "release"));
  } finally {
    w.dispose();
  }

  // The retained original signed build: attempt 1's aggregate failed and wrote
  // NO receipt; "re-run failed jobs" made attempt 2, whose re-executed
  // aggregate judged every lane and kept the ONE receipt (attempt 2), while
  // signed-build kept its original attempt-1 execution.
  const retained = (F) => {
    const { s, iso, aggregate, receiptFields, RECEIPT, receiptArtifactName } = F;
    const first = structuredClone(s.jobs);
    const failed = first.find((j) => j.name === "merge-gate");
    failed.conclusion = "failure";
    failed.steps = failed.steps.map((st) => (st.name === B.JUDGE_STEP ? { ...st, conclusion: "failure" }
      : st.name === B.RECORD_STEP || st.name === B.KEEP_STEP ? { ...st, conclusion: "skipped", started_at: null, completed_at: null } : st));
    s.history = { 1: { jobs: first, conclusion: "failure" } };
    const from = Date.parse(aggregate.completed_at) + 600000;
    const st = (number, name, a, b) => ({ number, name, status: "completed", conclusion: "success", started_at: iso(a), completed_at: iso(b) });
    const again = { ...structuredClone(aggregate), id: 799, run_attempt: 2, runner_name: "GitHub Actions 1799",
      started_at: iso(from), completed_at: iso(from + 60000),
      steps: [st(1, "Set up job", from, from + 1000), st(2, B.JUDGE_STEP, from + 2000, from + 10000),
        st(3, B.RECORD_STEP, from + 11000, from + 12000), st(4, B.KEEP_STEP, from + 13000, from + 20000), st(5, "Complete job", from + 59000, from + 60000)] };
    s.jobs = [...structuredClone(first).filter((j) => j.name !== "merge-gate"), again];
    s.run.run_attempt = 2;
    s.run.run_started_at = iso(from - 60000);
    const rz = F.receiptZip({ ...receiptFields, runAttempt: "2" });
    s.zips.set(RECEIPT, rz);
    Object.assign(s.artifacts[1], { name: receiptArtifactName(2), digest: `sha256:${sha256(rz)}`, size_in_bytes: rz.length,
      created_at: iso(from + 15000), updated_at: iso(from + 15000) });
  };
  let w2;
  await expect("bootstrap handoff: positive retained signed attempt 1 / latest attempt 2 (one receipt, of attempt 2)", async () => {
    w2 = await handoffWorld({ gateJobs: honestGateJobs, mode: "auto", producer: layer(retained) });
    const r2 = await w2.emit();
    const sb = r2.signedBuild;
    if (r2.schema !== H.HANDOFF_SCHEMA_V3 || sb.originalAttempt !== 1 || sb.producer.receipt.attempt !== 2
      || w2.decisionRecord.evidence.run.attempt !== 2) throw new Error(`froze ${JSON.stringify(sb).slice(0, 300)}`);
    await V(w2, r2, "main");
    w2.deliverMain();
    await V(w2, r2, "release");
    // The retained world, then a second receipt (attempt 1's) appears: ambiguous, never waived.
    w2.layer.F.s.artifacts.push({ ...w2.layer.F.s.artifacts[1], id: w2.layer.F.RECEIPT + 3,
      name: w2.layer.F.receiptArtifactName(1) });
    w2.layer.F.s.zips.set(w2.layer.F.RECEIPT + 3, w2.layer.F.s.zips.get(w2.layer.F.RECEIPT));
    let refusal = null;
    try { await V(w2, r2, "release"); } catch (error) { refusal = error; }
    if (!(refusal instanceof Refused) || !/carries 2 full-bootstrap receipts/.test(refusal.message)) {
      throw new Error(`a second (attempt-1) receipt was not refused as ambiguous: ${refusal?.message ?? "accepted"}`);
    }
  });
  w2?.dispose();
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  const { failures, passed } = await run();
  for (const f of failures) console.error(`FAIL ${f}`);
  console.log(`macos-handoff: ${passed} controls passed, ${failures.length} failed`);
  process.exitCode = failures.length ? 1 : 0;
}

export { HANDOFF_SCHEMA };
