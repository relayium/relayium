#!/usr/bin/env node
// scripts/test/ci-evidence-test.mjs — the PR→main evidence verifier, driven
// through its real code paths.
//
// scripts/ci/ci-evidence.mjs decides whether a `main` push may WITNESS a lane
// instead of re-running it. Every way it can be wrong in the dangerous
// direction — reusing a proof that does not cover this exact tree, this lane,
// this latest attempt — produces a green check over code nothing tested, and
// no hosted run would ever show it. So this file builds a complete, internally
// consistent GitHub world shaped like the real one (PR #156's merge-gate run:
// referenced workflows at the synthetic merge commit on `refs/pull/N/merge`, an
// empty `pull_requests` array, the 100-character truncation of matrix names,
// an artifact whose API digest is the sha256 of its zip), mints a REAL proof
// with `produce`, packs it the way upload-artifact does, and then:
//
//   1. proves `witness` accepts that world for every registered lane;
//   2. breaks one fact at a time — tree, head, repository, fork, ref, newer
//      failure, pending run, pagination, duplicates, missing matrix job, Web
//      scope, missing iPad, expired/deleted/foreign artifact, digest, attempt,
//      staleness, a push-run "proof", malformed manifest, API errors, a run
//      that changes while it is read — and requires a `NoReuse` naming it;
//   3. drives `produce`, `confirm`, the zip reader and the manifest schema
//      through their own refusals;
//   4. runs the real CLI as a child process against a local HTTP server, so
//      fetch, pagination parameters, the artifact redirect (whose second hop
//      must NOT carry the token), the `$GITHUB_OUTPUT` lines and the exit codes
//      are the shipped ones.
//
// Node's standard library only; it runs in the merge gate's aggregate job right
// before that job mints a proof with the same verifier.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { deflateRawSync } from "node:zlib";

import {
  FROZEN_REF, LIMITS, MANIFEST_SCHEMA, NATIVE_RELEASES_FILE, NoReuse, REGISTRY_FILE, SCOPE_FILE, confirm, crc32, gitHubApi,
  headFacts, listCounted, loadRegistry, main, produce, realGit, readSingleEntryZip, requiredJobs, validateManifest, validateWitness, witness,
} from "../ci/ci-evidence.mjs";
import { CANDIDATE_REF } from "../release/macos-evidence.mjs";
import { CANDIDATE_PATHS, OPTIONAL_GENERATED_PAGES } from "../../web/scripts/macos-release-candidate.mjs";
import { TOOLCHAIN_SCHEMA, loadToolchainRegistry, toolchainDigest } from "../ci/ci-evidence-toolchain.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const workflowsDir = resolve(repoRoot, ".github/workflows");
const registryText = readFileSync(resolve(repoRoot, REGISTRY_FILE), "utf8");
const REGISTRY = loadRegistry(registryText);
const TOOLREG = loadToolchainRegistry(readFileSync(resolve(repoRoot, "scripts/ci/ci-evidence-toolchain-registry.json"), "utf8"));

const failures = [];
let checks = 0;
const check = (ok, message) => { checks += 1; if (!ok) failures.push(message); };

// ── a consistent world ──────────────────────────────────────────────────────

const REPO = "relayium/relayium";
const REPO_ID = 1282331342;
const hex = (seed) => createHash("sha1").update(String(seed)).digest("hex");
const tmp = mkdtempSync(join(tmpdir(), "ci-evidence-test-"));

/**
 * git for building fixtures: this user's configuration, hooks, signing and
 * clock never shape an object, so every SHA below is reproducible.
 */
const FIXTURE_GIT_ENV = {
  ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t",
  GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t", GIT_AUTHOR_DATE: "1790000000 +0000", GIT_COMMITTER_DATE: "1790000000 +0000",
};
function fixtureGit(args, cwd, input) {
  const r = spawnSync("git", args, { cwd, env: FIXTURE_GIT_ENV, encoding: "utf8", input });
  if (r.status !== 0) throw new Error(`fixture git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
}

/**
 * The world's commits are REAL git objects, so a shallow clone of them can be
 * judged by the real git adapter against the same API world:
 *   BASE  — main before the change, a root commit;
 *   HEAD  — the pull request head, one commit on BASE;
 *   MERGE — the synthetic merge `refs/pull/N/merge` the gate checks out: [BASE, HEAD];
 *   MAIN  — main after it: one commit on BASE with the same TREE (the frozen
 *           dispatch candidate too), whose MESSAGE names HEAD as a "parent" —
 *           text after the header that no reader may take for one.
 */
const ORIGIN = join(tmp, "origin");
const { BASE, HEAD, MERGE, MAIN, TREE } = (() => {
  mkdirSync(ORIGIN);
  fixtureGit(["init", "-q", "--object-format=sha1", "-b", "fixture"], ORIGIN);
  const put = (path, text) => { mkdirSync(dirname(join(ORIGIN, path)), { recursive: true }); writeFileSync(join(ORIGIN, path), text); };
  for (const id of Object.keys(REGISTRY.lanes)) put(`.github/workflows/${REGISTRY.lanes[id].workflow}`, `# ${id}\n`);
  for (const path of ["server/main.go", "web/src/main.ts", "apps/ios/App.swift", "apps/mac/App.swift", "README.md"]) put(path, `${path}\n`);
  fixtureGit(["add", "-A"], ORIGIN);
  const baseTree = fixtureGit(["write-tree"], ORIGIN);
  const base = fixtureGit(["commit-tree", baseTree, "-m", "base"], ORIGIN);
  put("server/main.go", "package main\n");
  put("web/src/main.ts", "export {};\n");
  fixtureGit(["add", "-A"], ORIGIN);
  const tree = fixtureGit(["write-tree"], ORIGIN);
  const head = fixtureGit(["commit-tree", tree, "-p", base, "-m", "pull request head"], ORIGIN);
  const merge = fixtureGit(["commit-tree", tree, "-p", base, "-p", head, "-m", "Merge pull request head into base"], ORIGIN);
  const main = fixtureGit(["commit-tree", tree, "-p", base, "-F", "-"], ORIGIN, `release metadata\n\nparent ${head}\n`);
  for (const [branch, sha] of [["base", base], ["head", head], ["merge", merge], ["main", main]]) {
    fixtureGit(["update-ref", `refs/heads/${branch}`, sha], ORIGIN);
  }
  return { BASE: base, HEAD: head, MERGE: merge, MAIN: main, TREE: tree };
})();
const PR = 156;
const RUN = 36873812806;
const CUR_RUN = 36900000001;
const ART = 11200000001;
const TAGS_ART = 11200000002;
const NOW = new Date("2026-10-01T15:00:00Z");

const LANE_IDS = Object.keys(REGISTRY.lanes);
const CONDITIONAL = ["web", "go", "macos", "ios", "ios-transfer-interop", "android", "android-interop", "windows",
  "swift-package", "inbox-swift-interop", "native-web-pairing", "contracts", "ops-contract"];

/** A tracked file per lane, so every lane's fingerprint covers something. */
const TREE_FILES = [
  ...new Set([...LANE_IDS.map((id) => `.github/workflows/${REGISTRY.lanes[id].workflow}`),
    "scripts/ci/ci-evidence.mjs", "scripts/ci/ci-evidence-registry.json", "scripts/ci/select-lanes.mjs",
    "server/main.go", "web/src/main.ts", "apps/ios/App.swift", "apps/mac/App.swift", "README.md"]),
].sort();
const LS_TREE = TREE_FILES.map((p) => `100644 blob ${hex(`blob:${p}`)}\t${p}`).join("\0") + "\0";

const TAG_REFS = () => Array.from({ length: 69 }, (_, i) => ({ ref: `refs/tags/v0.${i}.0`, object: { sha: hex(`tag${i}`) } }));
/** The tags.txt bytes `git for-each-ref … | LC_ALL=C sort` writes for `refs`. */
const TAG_LINES = (refs) => refs.map((r) => `${r.ref} ${r.object.sha}`).sort().map((l) => `${l}\n`).join("");

// ── toolchain certificates (UNIT FIXTURES: shaped like the probe's output, never hosted evidence) ──

const FIXTURE_COMPONENTS = {
  image: (runner) => ({
    "ubuntu-latest": { runner_os: "Linux", runner_arch: "X64", image_os: "ubuntu24", image_version: "20260928.1", os_release: "ubuntu 24.04" },
    "macos-15": { runner_os: "macOS", runner_arch: "ARM64", image_os: "macos15", image_version: "20260929.0102", os_release: "macOS 15.7 (24G222)" },
    "windows-latest": { runner_os: "Windows", runner_arch: "X64", image_os: "win25", image_version: "20260928.1", os_release: "10.0.26100.6584" },
  })[runner],
  go: (runner) => ({ version: "go1.26.3", goos: { "macos-15": "darwin", "windows-latest": "windows" }[runner] ?? "linux",
    goarch: runner === "macos-15" ? "arm64" : "amd64", cgo_enabled: "1", cc: runner === "macos-15" ? "clang" : "gcc",
    cc_path: runner === "macos-15" ? "/usr/bin/clang" : "/usr/bin/x86_64-linux-gnu-gcc-13",
    cc_target: { "macos-15": "arm64-apple-darwin24.6.0", "windows-latest": "x86_64-w64-mingw32" }[runner] ?? "x86_64-linux-gnu",
    cc_version: runner === "macos-15" ? "Apple clang version 17.0.0 (clang-1700.3.19.1)" : "gcc (Ubuntu 13.3.0-6ubuntu2~24.04) 13.3.0" }),
  node: () => ({ version: "v24.9.0", npm: "11.6.0" }),
  java: () => ({ version: "17.0.16", build: "17.0.16+8" }),
  "android-sdk": () => ({ "platforms;android-37.0": "1", "build-tools;36.0.0": "36.0.0" }),
  chrome: () => ({ pinned: false, path: "/usr/bin/google-chrome", real_path: "/opt/google/chrome/google-chrome", sha256: "c".repeat(64), version: "Google Chrome 141.0.7390.54" }),
  xcode: () => ({ installed: [{ app: "/Applications/Xcode_26.0.1.app", version: "26.0.1", build: "17A400", macosx_sdk: "26.0", iphonesimulator_sdk: "26.0" },
    { app: "/Applications/Xcode_16.4.app", version: "16.4", build: "16F6", macosx_sdk: "15.5", iphonesimulator_sdk: "18.5" }],
  default_developer_dir: "/Applications/Xcode_16.4.app/Contents/Developer",
  used: { app: "/Applications/Xcode_16.4.app", version: "16.4", build: "16F6" } }),
  destination: (runner, p) => ({ rule: p.destination, program_sha256: TOOLREG.destinations[p.destination].sha256,
    interpreter: { path: "/usr/bin/python3", version: "Python 3.9.6" },
    selected: { name: "iPhone 17 Pro", device_type: "com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro", listing_position: 1,
      runtime: "com.apple.CoreSimulator.SimRuntime.iOS-26-0", runtime_version: "26.0", runtime_build: "23A339" } }),
};
const fixtureToolchain = (profile) => {
  const p = TOOLREG.profiles[profile];
  return Object.fromEntries(p.components.map((c) => [c, FIXTURE_COMPONENTS[c](p.runner, p)]));
};
function makeCert({ role, profile, lane, jobId, index = 0, total = 1, runId, attempt, sha, workflowRef, toolchain, capturedAt }) {
  const t = toolchain ?? fixtureToolchain(profile);
  return {
    schema: TOOLCHAIN_SCHEMA,
    binding: { role, profile, lane, job: jobId, repository_id: REPO_ID, run_id: runId, run_attempt: attempt, sha,
      workflow_ref: workflowRef, github_job: role === "source" ? jobId : "evidence", job_index: index, job_total: total },
    toolchain: t,
    digest: toolchainDigest(profile, t),
    audit: { captured_at: capturedAt, developer_dir: "", matrix: "", simulator_udid: "" },
  };
}

function job(id, name, conclusion, labels, status = "completed") {
  return { id, name, status, conclusion, labels, run_attempt: 1, head_sha: HEAD };
}

/** Every job of the source run, shaped like the API's (prefixed lane checks). */
function sourceJobs() {
  const out = [job(1, "select", "success", ["ubuntu-latest"])];
  let id = 100;
  for (const [laneId, lane] of Object.entries(REGISTRY.lanes)) {
    out.push(job(id += 1, `${laneId} / evidence`, "success", ["ubuntu-latest"]));
    if (Object.keys(TOOLREG.lanes[laneId]?.certify ?? {}).length > 0) out.push(job(id += 1, `${laneId} / screen`, "skipped", []));
    for (const runner of Object.keys(TOOLREG.lanes[laneId]?.certify ?? {})) {
      out.push(job(id += 1, `${laneId} / certify-${runner === "macos-15" ? "macos" : "windows"}`, "skipped", []));
    }
    for (const entry of Object.values(lane.jobs)) {
      for (const check of entry.checks) out.push(job(id += 1, `${laneId} / ${check}`, "success", [entry.runner]));
    }
  }
  for (const name of ["windows / build", "windows / native", "windows / realtime"]) out.push(job(id += 1, name, "success", ["windows-latest"]));
  for (let i = 0; i < 60; i += 1) out.push(job(id += 1, `repo-hygiene / policy-${i}`, "success", ["ubuntu-latest"]));
  out.push(job(9999, "merge-gate", "success", ["ubuntu-latest"]));
  return out;
}

const referenced = (sha, ref = `refs/pull/${PR}/merge`) => [...CONDITIONAL.map((id) => (id === "ops-contract" ? "ops-deploy-contract" : id)),
  "compat", "repo-hygiene"].map((wf) => ({ path: `${REPO}/.github/workflows/${wf}.yml@${sha}`, sha, ref }));

function baseWorld() {
  return {
    now: NOW,
    pulls: [{ number: PR, merged_at: "2026-10-01T14:32:00Z", merge_commit_sha: MAIN, base: { ref: "main", repo: { id: REPO_ID } } }],
    pr: {
      number: PR, merged: true, merge_commit_sha: MAIN, base: { ref: "main", sha: BASE, repo: { id: REPO_ID } },
      head: { sha: HEAD, repo: { id: REPO_ID } },
    },
    runs: [{
      id: RUN, head_sha: HEAD, created_at: "2026-10-01T14:06:59Z", run_started_at: "2026-10-01T14:06:59Z", run_attempt: 1,
      event: "pull_request", status: "completed", conclusion: "success",
    }],
    run: {
      id: RUN, run_attempt: 1, run_started_at: "2026-10-01T14:06:59Z", event: "pull_request", status: "completed", conclusion: "success",
      path: ".github/workflows/merge-gate.yml", head_sha: HEAD, repository: { id: REPO_ID },
      head_repository: { id: REPO_ID }, updated_at: "2026-10-01T14:29:40Z", pull_requests: [],
      referenced_workflows: referenced(MERGE),
    },
    mergeCommit: { sha: MERGE, tree: { sha: TREE }, parents: [{ sha: BASE }, { sha: HEAD }] },
    jobs: sourceJobs(),
    tags: TAG_REFS(),
    // What the Web `test` job recorded right after its own checkout (its artifact).
    testedTags: TAG_LINES(TAG_REFS()),
    tagsArtifactName: "relayium-ci-evidence-web-tags-attempt-1",
    tagsPatch: {},
    current: {
      id: CUR_RUN, run_attempt: 1, head_sha: MAIN, event: "push", head_branch: "main", repository: { id: REPO_ID },
    },
    artifactName: "relayium-ci-evidence-proof-attempt-1",
    artifactPatch: {},
    zip: null,
    gitTree: TREE,
    hooks: {},
    // Source certificate overrides: key `<lane>/<job>/<index>` → (cert) => cert | null (absent).
    certPatch: {},
    certAttempt: 1,
    // Current certificate overrides: profile → (cert) => cert | null (absent).
    currentPatch2: {},
  };
}

/** A paginated slice of `items` for `?per_page=&page=`. */
function page(items, query) {
  const per = Number(query.get("per_page") ?? 30);
  const n = Number(query.get("page") ?? 1);
  return items.slice((n - 1) * per, n * per);
}

/** The mock API over a world. `calls` counts every path served. */
function mockApi(world) {
  const calls = new Map();
  const counted = (path) => { calls.set(path, (calls.get(path) ?? 0) + 1); return calls.get(path); };
  const json = async (path) => {
    const url = new URL(path, "https://api.test/");
    const p = url.pathname.replace(/^\//, "");
    const q = url.searchParams;
    // Run listings are counted per head: the PR head and this main commit are two listings.
    const n = counted(q.get("head_sha") ? `${p}@${q.get("head_sha")}` : p);
    const hook = q.get("head_sha") === MAIN ? undefined : world.hooks[p];
    if (hook) { const r = hook(n, q); if (r !== undefined) return r; }
    const base = `repos/${REPO}/`;
    if (p === `${base}commits/${MAIN}/pulls`) return page(world.pulls, q);
    if (p === `${base}pulls/${PR}`) return structuredClone(world.pr);
    if (p === `${base}actions/workflows/merge-gate.yml/runs`) {
      // Runs whose head is THIS main commit: none for a pull request merge (the gate
      // has no push trigger); the frozen dispatch world puts its run here.
      const list = q.get("head_sha") === HEAD ? world.runs : q.get("head_sha") === MAIN ? (world.mainRuns ?? []) : null;
      if (list === null) throw new NoReuse(`mock: runs for unexpected head ${q.get("head_sha")}`);
      return { total_count: list.length, workflow_runs: page(list, q) };
    }
    const SRC = world.run.id;
    const SRC_HEAD = world.run.head_sha;
    if (p === `${base}actions/runs/${SRC}`) return structuredClone(world.run);
    if (p === `${base}actions/runs/${CUR_RUN}`) return structuredClone(world.current);
    if (p === `${base}git/commits/${world.mergeCommit.sha}`) return structuredClone(world.mergeCommit);
    if (p === `${base}git/ref/heads/main`) return structuredClone(world.mainRef ?? { object: { sha: BASE } });
    if (p === `${base}compare/${BASE}...${MAIN}`) return structuredClone(world.compare);
    if (p === `${base}contents/${SCOPE_FILE}` && q.get("ref") === BASE) return structuredClone(world.scopeBlob ?? SCOPE_BLOB);
    const jobsPath = /^repos\/relayium\/relayium\/actions\/runs\/(\d+)\/attempts\/(\d+)\/jobs$/.exec(p);
    if (jobsPath) {
      const list = world.jobs.filter((j) => j.run_attempt === Number(jobsPath[2]));
      return { total_count: world.jobsTotal ?? list.length, jobs: page(list, q) };
    }
    if (p === `${base}actions/runs/${SRC}/artifacts`) {
      const list = artifactTable(world).map(({ id, name, bytes, patch }) => ({
        id, name, expired: false, expires_at: "2026-10-08T14:29:00Z",
        size_in_bytes: bytes.length, digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
        workflow_run: { id: SRC, head_sha: SRC_HEAD, repository_id: REPO_ID, head_repository_id: REPO_ID },
        ...patch,
      })).filter((a) => a.name === q.get("name"));
      return { total_count: list.length, artifacts: page(list, q) };
    }
    if (p === `${base}git/matching-refs/tags`) return page(world.tags, q);
    throw new NoReuse(`mock: GET ${path} returned HTTP 404`);
  };
  return {
    calls,
    json,
    async download(path, max) {
      const n = counted(path);
      const hook = world.hooks[`download:${path}`];
      if (hook) { const r = hook(n); if (r !== undefined) return r; }
      const id = Number(/^repos\/relayium\/relayium\/actions\/artifacts\/(\d+)\/zip$/.exec(path)?.[1]);
      const hit = artifactTable(world).find((a) => a.id === id);
      if (!hit) throw new NoReuse(`mock: downloading ${path} returned HTTP 404`);
      if (hit.bytes.length > max) throw new NoReuse("mock: too large");
      return hit.bytes;
    },
  };
}

function tagsZip(world) {
  return zipOf([{ name: "tags.txt", data: world.testedTags }]);
}

/** Every artifact the source run carries: the proof, Web's tested tags, and one certificate per job execution. */
function artifactTable(world) {
  const out = [{ id: ART, name: world.artifactName, bytes: world.zip, patch: world.artifactPatch }];
  if (world.testedTags !== null) out.push({ id: TAGS_ART, name: world.tagsArtifactName, bytes: world.tagsZipOverride ?? tagsZip(world), patch: world.tagsPatch });
  let id = 11300000000;
  for (const [laneId, lane] of Object.entries(REGISTRY.lanes)) {
    for (const [jobId, entry] of Object.entries(lane.jobs)) {
      const t = TOOLREG.lanes[laneId]?.jobs?.[jobId];
      if (entry.mode === "fresh" || !t?.profile) continue;
      entry.checks.forEach((_, index) => {
        id += 1;
        let cert = makeCert({ role: "source", profile: t.profile, lane: laneId, jobId, index, total: entry.checks.length,
          runId: world.run.id, attempt: world.run.run_attempt, sha: world.certSha ?? MERGE,
          workflowRef: `${REPO}/.github/workflows/merge-gate.yml@${world.certRef ?? `refs/pull/${PR}/merge`}`, capturedAt: "2026-10-01T14:20:00Z" });
        const patch = world.certPatch[`${laneId}/${jobId}/${index}`];
        if (patch) cert = patch(cert);
        if (cert === null) return;
        const bytes = cert instanceof Buffer ? cert : zipOf([{ name: "toolchain.json", data: JSON.stringify(cert) }]);
        out.push({ id, name: `relayium-ci-evidence-toolchain-${laneId}-${jobId}-${index}-attempt-${world.certAttempt}`, bytes, patch: {} });
      });
    }
  }
  return out;
}

/** The certificates a main push's probes would have written for `laneId`. */
function currentCerts(world, laneId, env) {
  const map = new Map();
  for (const name of Object.keys(TOOLREG.profiles)) {
    let cert = makeCert({ role: "current", profile: name, lane: "-", jobId: "-", runId: Number(env.GITHUB_RUN_ID),
      attempt: Number(env.GITHUB_RUN_ATTEMPT), sha: env.GITHUB_SHA, workflowRef: env.GITHUB_WORKFLOW_REF,
      capturedAt: new Date(world.now.getTime() - 60_000).toISOString().replace(/\.\d{3}Z$/, "Z") });
    const patch = world.currentPatch2[name];
    if (patch) cert = patch(cert);
    if (cert !== null) map.set(name, cert);
  }
  return map;
}

/** A raw commit object as `git cat-file commit` prints it: header, blank line, message. */
const rawCommit = (tree, parents, message = "fixture\n") => `tree ${tree}\n${parents.map((p) => `parent ${p}\n`).join("")}`
  + "author t <t@t> 1790000000 +0000\ncommitter t <t@t> 1790000000 +0000\n\n" + message;

/**
 * git as the verifier calls it, with real git's semantics: `%H`/`%T` from the
 * commit, the parents only in the raw object (a `world.gitRaw` replaces it).
 */
function gitFor(world, sha) {
  return (args) => {
    const cmd = args.join(" ");
    if (cmd === "show -s --format=%H%n%T HEAD") return Buffer.from(`${sha}\n${world.gitTree}\n`);
    // What a FULL clone prints. The verifier must not ask: a shallow one prints no parents (section 2e).
    if (cmd === "show -s --format=%H%n%T%n%P HEAD") return Buffer.from(`${sha}\n${world.gitTree}\n${world.gitParents ?? `${BASE} ${HEAD}`}\n`);
    if (cmd === `cat-file commit ${sha}`) {
      return Buffer.from(world.gitRaw ?? rawCommit(world.gitTree, (world.gitParents ?? `${BASE} ${HEAD}`).split(" ").filter(Boolean)));
    }
    if (cmd === "ls-tree -r -z --full-tree HEAD") return Buffer.from(world.lsTree ?? LS_TREE);
    throw new Error(`mock git: unexpected ${cmd}`);
  };
}

// The BASE-owned release-metadata whitelist, as the contents API reports it.
const SCOPE_BYTES = readFileSync(resolve(repoRoot, SCOPE_FILE));
const SCOPE_BLOB = { type: "file", path: SCOPE_FILE,
  sha: createHash("sha1").update(`blob ${SCOPE_BYTES.length}\0`).update(SCOPE_BYTES).digest("hex") };
/** The candidate's files as the verifier reads them: the real tree, except what a world overrides. */
const worldReadFile = (world) => (path) => (world.files?.[path] !== undefined
  ? Buffer.from(world.files[path]) : readFileSync(resolve(repoRoot, path)));

function writeJson(name, value) {
  const path = join(tmp, name);
  writeFileSync(path, JSON.stringify(value));
  return path;
}

const PR_EVENT = writeJson("pr-event.json", {
  pull_request: {
    number: PR, head: { sha: HEAD, repo: { id: REPO_ID } }, base: { sha: BASE, ref: "main", repo: { id: REPO_ID } },
  },
});

function produceEnv(overrides = {}) {
  const needs = { select: { result: "success" } };
  const selected = {};
  for (const id of CONDITIONAL) { needs[id] = { result: "success" }; selected[id] = "true"; }
  needs.compat = { result: "success" };
  needs["repo-hygiene"] = { result: "success" };
  return {
    GITHUB_EVENT_NAME: "pull_request", GITHUB_REPOSITORY: REPO, GITHUB_REPOSITORY_ID: String(REPO_ID),
    GITHUB_RUN_ID: String(RUN), GITHUB_RUN_ATTEMPT: "1", GITHUB_EVENT_PATH: PR_EVENT, GITHUB_SHA: MERGE,
    GITHUB_WORKFLOW_SHA: MERGE, GITHUB_WORKFLOW_REF: `${REPO}/.github/workflows/merge-gate.yml@refs/pull/${PR}/merge`,
    CI_EVIDENCE_NEEDS: JSON.stringify(needs), CI_EVIDENCE_SELECTED: JSON.stringify(selected),
    RUNNER_OS: "Linux", RUNNER_ARCH: "X64", ImageOS: "ubuntu24", ImageVersion: "20260928.1",
    ...overrides,
  };
}

/** The world as the producer sees it: its own aggregate still running. */
function producerWorld(world) {
  const w = structuredClone(world);
  w.run = { ...w.run, status: "in_progress", conclusion: null };
  w.jobs = w.jobs.map((j) => (j.name === "merge-gate" ? { ...j, status: "in_progress", conclusion: null } : j));
  return w;
}

async function mint(world, env = produceEnv()) {
  const pw = producerWorld(world);
  return produce({ env, api: mockApi(pw), git: gitFor(pw, MERGE), registry: REGISTRY, now: () => new Date("2026-10-01T14:29:30Z"), workflowsDir });
}

// ── a zip writer shaped like upload-artifact's (deflate + data descriptor) ──

function zipOf(entries) {
  const locals = [];
  const central = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name, "utf8");
    const data = Buffer.from(e.data);
    const method = e.method ?? 8;
    const body = method === 8 ? deflateRawSync(data) : data;
    const crc = e.crc ?? crc32(data);
    const flags = e.flags ?? 0x0008;
    const usize = e.usize ?? data.length;
    const csize = e.csize ?? body.length;
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(flags, 6); lh.writeUInt16LE(method, 8);
    lh.writeUInt16LE(name.length, 26);
    const dd = Buffer.alloc(16);
    dd.writeUInt32LE(0x08074b50, 0); dd.writeUInt32LE(crc, 4); dd.writeUInt32LE(csize >>> 0, 8); dd.writeUInt32LE(usize >>> 0, 12);
    const local = Buffer.concat([lh, name, body, dd]);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(0x031e, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(flags, 8);
    ch.writeUInt16LE(method, 10); ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(csize >>> 0, 20); ch.writeUInt32LE(usize >>> 0, 24);
    ch.writeUInt16LE(name.length, 28); ch.writeUInt32LE((e.ext ?? 0o100644) * 0x10000 >>> 0, 38); ch.writeUInt32LE(offset, 42);
    central.push(Buffer.concat([ch, name]));
    locals.push(local);
    offset += local.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

const zipManifest = (manifest) => zipOf([{ name: "ci-evidence.json", data: `${JSON.stringify(manifest, null, 2)}\n` }]);

function pushEnv(laneId, overrides = {}) {
  const event = writeJson(`push-${laneId}.json`, {
    ref: "refs/heads/main", after: MAIN, before: BASE, created: false, deleted: false, forced: false, repository: { id: REPO_ID },
  });
  return {
    GITHUB_EVENT_NAME: "push", GITHUB_REF: "refs/heads/main", GITHUB_REPOSITORY: REPO, GITHUB_REPOSITORY_ID: String(REPO_ID),
    GITHUB_SHA: MAIN, GITHUB_RUN_ID: String(CUR_RUN), GITHUB_RUN_ATTEMPT: "1", GITHUB_EVENT_PATH: event,
    GITHUB_WORKFLOW_REF: `${REPO}/.github/workflows/${REGISTRY.lanes[laneId].workflow}@refs/heads/main`,
    ...overrides,
  };
}

async function runWitness(world, laneId, envOverrides = {}) {
  const { hooks, zip, certPatch, currentPatch2, toolchainRegistry, tagsZipOverride, loadScope, git, ...data } = world;
  const w = structuredClone(data);
  w.hooks = hooks;
  w.zip = zip;
  w.toolchainRegistry = toolchainRegistry;
  w.tagsZipOverride = tagsZipOverride;
  w.current = { ...w.current, path: `.github/workflows/${REGISTRY.lanes[laneId].workflow}`, ...(world.currentPatch ?? {}) };
  w.certPatch = world.certPatch;
  w.currentPatch2 = world.currentPatch2;
  const api = mockApi(w);
  const env = pushEnv(laneId, envOverrides);
  try {
    const out = await witness({ env, api, git: git ?? gitFor(w, MAIN), registry: world.registry ?? REGISTRY, readFile: worldReadFile(world),
      ...(world.loadScope ? { loadScope: world.loadScope } : {}), screen: world.screen === true,
      laneId, now: () => world.now, workflowsDir, toolchainRegistry: world.toolchainRegistry === undefined ? TOOLREG : world.toolchainRegistry,
      currentCertificates: world.noCurrentCerts ? undefined : currentCerts(w, laneId, env) });
    return { ok: true, witness: out, api };
  } catch (err) {
    return { ok: false, error: err, api };
  }
}

// ── 1. the positive world, for every lane ───────────────────────────────────

const manifest = await mint(baseWorld());
check(manifest.schema === MANIFEST_SCHEMA && manifest.checkout.sha === MERGE && manifest.checkout.tree === TREE
  && manifest.checkout.ref === `refs/pull/${PR}/merge` && manifest.pull_request.head_sha === HEAD
  && manifest.jobs.every((j) => j.name !== "merge-gate") && Object.keys(manifest.fingerprints).length === LANE_IDS.length,
`produce did not record the merge commit, tree, PR head, job inventory and every lane's fingerprint: ${JSON.stringify(manifest).slice(0, 400)}`);
check(manifest.toolchain.image_version === "20260928.1" && manifest.toolchain.node === process.version,
  "produce did not record the producer's actual toolchain facts");

function freshWorld(patchManifest) {
  const w = baseWorld();
  const m = structuredClone(manifest);
  if (patchManifest) patchManifest(m);
  w.zip = zipManifest(m);
  return w;
}

const UNCERTIFIABLE_LANES = LANE_IDS.filter((id) => Object.values(TOOLREG.lanes[id]?.jobs ?? {}).some((j) => j.uncertifiable));
check(JSON.stringify(UNCERTIFIABLE_LANES) === JSON.stringify(["android-interop"]),
  `the uncertifiable lanes are ${JSON.stringify(UNCERTIFIABLE_LANES)}; this file's expectations name android-interop only`);
for (const laneId of LANE_IDS) {
  const r = await runWitness(freshWorld(), laneId, laneId === "web" ? { CI_EVIDENCE_SCOPE_LIGHT: "true" } : {});
  if (UNCERTIFIABLE_LANES.includes(laneId)) {
    check(!r.ok && /is uncertifiable: the emulator system image/.test(r.error?.message ?? ""),
      `lane ${laneId} has an uncertifiable job but was ${r.ok ? "REUSED" : `refused for another reason: ${r.error?.message}`}`);
    continue;
  }
  check(r.ok, `lane ${laneId}: the consistent world was refused: ${r.error?.message}`);
  if (!r.ok) continue;
  check(Object.keys(r.witness.certificates).sort().join() === Object.keys(r.witness.jobs).sort().join()
    && Object.entries(r.witness.certificates).every(([jobId, c]) => c.source.length === REGISTRY.lanes[laneId].jobs[jobId].checks.length),
  `lane ${laneId}: the witness does not carry one source certificate per witnessed check`);
  const w = r.witness;
  const lane = REGISTRY.lanes[laneId];
  const reusable = Object.entries(lane.jobs).filter(([, j]) => j.mode !== "fresh").map(([id]) => id).sort();
  check(JSON.stringify(Object.keys(w.jobs).sort()) === JSON.stringify(reusable),
    `lane ${laneId}: the witness vouches for [${Object.keys(w.jobs)}], want the reusable jobs [${reusable}] (never a fresh one)`);
  check(w.target.sha === MAIN && w.target.tree === TREE && w.source.merge_sha === MERGE && w.source.run_id === RUN
    && w.source.artifact_id === ART && w.source.pull_request === PR, `lane ${laneId}: the witness does not bind main, source run and artifact`);
  // The decision re-reads the source run and the run listing, and reads THIS run.
  check((r.api.calls.get(`repos/${REPO}/actions/runs/${RUN}`) ?? 0) >= 2
    && (r.api.calls.get(`repos/${REPO}/actions/runs/${CUR_RUN}`) ?? 0) === 1,
  `lane ${laneId}: the source run was not re-read before reuse, or the current run was not read`);
}
check(!(await runWitness(freshWorld(), "macos")).witness?.jobs?.["signed-build"], "the macOS signed build was witnessed; it must stay fresh");

// ── 2. one broken fact at a time ────────────────────────────────────────────

const later = (iso, ms) => new Date(Date.parse(iso) + ms).toISOString().replace(/\.\d{3}Z$/, "Z");
const rezip = (w, patch) => { const m = JSON.parse(readSingleEntryZip(w.zip, "ci-evidence.json")); patch(m); w.zip = zipManifest(m); };

/** A current certificate whose toolchain differs in one fact (digest recomputed, so only the comparison can refuse it). */
const drift = (profile, change) => (w) => {
  w.currentPatch2[profile] = (c) => { const t = structuredClone(c.toolchain); change(t); return { ...c, toolchain: t, digest: toolchainDigest(profile, t) }; };
};
const srcPatch = (key, change) => (w) => { w.certPatch[key] = (c) => { const x = structuredClone(c); change(x); return x; }; };
const rebind = (key, change) => srcPatch(key, (c) => change(c.binding));

const NEGATIVES = [
  // ── the toolchain (actual source certificate vs current probe) ──
  ["a check's source certificate is missing", "go", (w) => { w.certPatch["go/race-account/7"] = () => null; },
    /carries 0 artifact\(s\) named relayium-ci-evidence-toolchain-go-race-account-7-attempt-1/],
  ["the certificates are from another attempt", "go", (w) => { w.certAttempt = 2; },
    /carries 0 artifact\(s\) named relayium-ci-evidence-toolchain-go-test-0-attempt-1/],
  ["a certificate is for another matrix entry", "go", rebind("go/race-account/3", (b) => { b.job_index = 4; }),
    /relayium-ci-evidence-toolchain-go-race-account-3-attempt-1 is not go\/race-account entry 3 of 8/],
  ["a certificate claims another matrix size", "go", rebind("go/race-account/0", (b) => { b.job_total = 9; }),
    /is not go\/race-account entry 0 of 8/],
  ["a certificate is another job's", "web", rebind("web/test/0", (b) => { b.job = "sealed-box-interop"; b.github_job = "sealed-box-interop"; }),
    /is not web\/test entry 0 of 1/],
  ["a certificate is from another run", "go", rebind("go/test/0", (b) => { b.run_id = RUN + 1; }), /is not go\/test entry 0 of 1 from merge-gate run/],
  ["a certificate was captured on the PR head, not the tested merge", "go", rebind("go/test/0", (b) => { b.sha = HEAD; }), /is not go\/test entry 0/],
  ["a certificate comes from a main push run (recursive)", "go", rebind("go/test/0", (b) => { b.workflow_ref = `${REPO}/.github/workflows/go.yml@refs/heads/main`; }),
    /is not go\/test entry 0/],
  ["a current certificate is offered as a source", "go", rebind("go/test/0", (b) => { b.role = "current"; }), /is not go\/test entry 0/],
  ["a certificate's toolchain was edited without its digest", "go", srcPatch("go/test/0", (c) => { c.toolchain.image.image_version = "20260101.1"; }),
    /is not a usable certificate: a certificate's digest does not match/],
  ["a certificate names another profile", "go", srcPatch("go/test/0", (c) => {
    c.binding.profile = "linux-node"; c.toolchain = fixtureToolchain("linux-node"); c.digest = toolchainDigest("linux-node", c.toolchain);
  }), /is not go\/test entry 0/],
  ["a certificate carries an unknown component", "go", srcPatch("go/test/0", (c) => {
    c.toolchain.node = { version: "v24.9.0", npm: "11.6.0" }; c.digest = toolchainDigest("linux-go", c.toolchain);
  }), /does not carry exactly its components/],
  ["a certificate is not JSON", "go", (w) => { w.certPatch["go/test/0"] = () => zipOf([{ name: "toolchain.json", data: "{" }]); },
    /is not a usable certificate: not JSON/],
  ["the ubuntu image moved since the source ran", "go", drift("linux-go", (t) => { t.image.image_version = "20261005.1"; }),
    /different toolchain than this runner family offers now \(linux-go: image\.image_version\)/],
  ["the C compiler cgo/-race uses changed", "go", drift("linux-go", (t) => { t.go.cc_version = "gcc (Ubuntu 13.3.0-6ubuntu2~24.04.1) 13.3.0"; }),
    /linux-go: go\.cc_version/],
  ["the cgo compiler now targets another machine (same version line)", "go", drift("linux-go", (t) => { t.go.cc_target = "aarch64-linux-gnu"; }),
    /linux-go: go\.cc_target/],
  ["setup-go resolves another Go", "contracts", drift("linux-go", (t) => { t.go.version = "go1.26.4"; }), /linux-go: go\.version/],
  ["setup-node's floating 24.x moved", "compat", drift("linux-node", (t) => { t.node.version = "v24.10.0"; }), /linux-node: node\.version/],
  ["the image's Chrome patch moved", "web", drift("linux-node-chrome", (t) => { t.chrome.version = "Google Chrome 141.0.7390.65"; }), /linux-node-chrome: chrome\.version/],
  ["the harness would now launch another Chrome binary", "web", drift("linux-node-chrome", (t) => { t.chrome.sha256 = "d".repeat(64); }), /linux-node-chrome: chrome\.sha256/],
  ["the harness would now launch a CHROME_PATH browser", "web", drift("linux-node-go-chrome", (t) => { t.chrome.pinned = true; t.chrome.path = "/opt/chromium/chrome"; }),
    /linux-node-go-chrome: chrome\.pinned, chrome\.path/],
  ["setup-java's floating 17 moved", "compat", drift("linux-java", (t) => { t.java.build = "17.0.17+10"; }), /linux-java: java\.build/],
  ["an Android package revision moved", "android", drift("linux-java-android", (t) => { t["android-sdk"]["build-tools;36.0.0"] = "36.0.1"; }),
    /linux-java-android: android-sdk\.build-tools;36\.0\.0/],
  ["the macOS image's Xcode build changed", "ios", drift("macos-xcode-iphone", (t) => { t.xcode.installed[0].build = "17A401"; }),
    /macos-xcode-iphone: xcode\.installed/],
  ["a newer Xcode 26 patch appeared (the iOS selection would pick it)", "ios", drift("macos-xcode", (t) => {
    t.xcode.installed.push({ app: "/Applications/Xcode_26.0.2.app", version: "26.0.2", build: "17A410", macosx_sdk: "26.0", iphonesimulator_sdk: "26.0" });
  }), /macos-xcode: xcode\.installed/],
  ["the image's default Xcode changed", "macos", drift("macos-xcode", (t) => { t.xcode.default_developer_dir = "/Applications/Xcode_26.0.1.app/Contents/Developer"; }),
    /macos-xcode: xcode\.default_developer_dir/],
  ["the iPhone the UI smoke's own rule picks is on a new runtime build", "ios", drift("macos-xcode-iphone", (t) => { t.destination.selected.runtime_build = "23A340"; }),
    /macos-xcode-iphone: destination\.selected\.runtime_build/],
  ["the iPhone rule now picks another device", "ios", drift("macos-xcode-iphone", (t) => {
    t.destination.selected = { ...t.destination.selected, name: "iPhone 16", device_type: "com.apple.CoreSimulator.SimDeviceType.iPhone-16", listing_position: 4 };
  }), /macos-xcode-iphone: destination\.selected\.name, destination\.selected\.device_type, destination\.selected\.listing_position/],
  ["the iPad rule now picks another device type", "ios", drift("macos-xcode-ipad", (t) => { t.destination.selected.device_type = "com.apple.CoreSimulator.SimDeviceType.iPad-mini-A17-Pro"; }),
    /macos-xcode-ipad: destination\.selected\.device_type/],
  ["the session acceptance script's interpreter moved", "ios-transfer-interop", drift("macos-xcode-go-iphone", (t) => { t.destination.interpreter.version = "Python 3.14.0"; }),
    /macos-xcode-go-iphone: destination\.interpreter\.version/],
  ["the macOS image moved", "swift-package", drift("macos-xcode-go", (t) => { t.image.image_version = "20261006.0201"; }), /macos-xcode-go: image\.image_version/],
  ["the pairing Mac's Chrome moved (brew installed a newer cask)", "native-web-pairing", drift("macos-xcode-node-go-chrome", (t) => { t.chrome.version = "Google Chrome 142.0.7444.10"; }),
    /macos-xcode-node-go-chrome: chrome\.version/],
  ["the Windows image moved", "web", drift("windows-node", (t) => { t.image.image_version = "20261005.1"; }), /windows-node: image\.image_version/],
  ["the macOS contract's Ubuntu image moved", "macos", drift("linux-base", (t) => { t.image.os_release = "ubuntu 26.04"; }), /linux-base: image\.os_release/],
  ["no current certificate for a native profile", "ios", (w) => { w.currentPatch2["macos-xcode-ipad"] = () => null; },
    /no current macos-xcode-ipad certificate was captured/],
  ["no current certificates at all", "go", (w) => { w.noCurrentCerts = true; }, /no current toolchain certificates were captured/],
  ["a current certificate from another attempt", "go", (w) => { w.currentPatch2["linux-go"] = (c) => ({ ...c, binding: { ...c.binding, run_attempt: 2 } }); },
    /current linux-go certificate was not captured by this run and attempt/],
  ["a current certificate from another commit", "go", (w) => { w.currentPatch2["linux-go"] = (c) => ({ ...c, binding: { ...c.binding, sha: HEAD } }); },
    /current linux-go certificate was not captured by this run/],
  ["a current certificate from another lane's run", "go", (w) => { w.currentPatch2["linux-go"] = (c) => ({ ...c, binding: { ...c.binding, workflow_ref: `${REPO}/.github/workflows/web.yml@refs/heads/main` } }); },
    /current linux-go certificate was not captured by this run/],
  ["a stale current certificate", "go", (w) => {
    w.currentPatch2["linux-go"] = (c) => ({ ...c, audit: { ...c.audit, captured_at: new Date(w.now.getTime() - 40 * 60_000).toISOString().replace(/\.\d{3}Z$/, "Z") } });
  }, /not captured by this run and attempt on this commit just now/],
  ["a malformed current certificate", "go", (w) => { w.currentPatch2["linux-go"] = (c) => ({ ...c, extra: 1 }); },
    /current linux-go certificate is unusable: a certificate has the wrong keys/],
  ["a job has no toolchain profile", "go", (w) => {
    const r = structuredClone(TOOLREG); delete r.lanes.go.jobs["rollback-floor"]; w.toolchainRegistry = r;
  }, /go\/rollback-floor has no toolchain profile/],
  ["no toolchain registry", "go", (w) => { w.toolchainRegistry = null; }, /no toolchain registry: nothing is certified/],
  ["the tested tree is not main's tree", "go", (w) => { w.gitTree = hex("another-tree"); }, /tested tree .* is not this commit's tree/],
  ["the merge commit's tree differs", "go", (w) => { w.mergeCommit.tree.sha = hex("x"); }, /tested tree .* is not this commit's tree/],
  ["the proof names another PR head", "go", (w) => rezip(w, (m) => { m.pull_request.head_sha = hex("forged"); }), /names another pull request or head/],
  ["a listed run is for another head", "go", (w) => { w.runs[0].head_sha = hex("forged"); }, /malformed or for another head/],
  ["the merge's second parent is not the PR head", "go", (w) => { w.mergeCommit.parents[1].sha = hex("other"); }, /not a merge of the pull request head/],
  ["the source run is in another repository", "go", (w) => { w.run.repository.id = 1; }, /not a completed same-repository pull_request success/],
  ["the proof is for another repository", "go", (w) => rezip(w, (m) => { m.repository.id = 1; }), /another repository/],
  ["the pull request comes from a fork", "go", (w) => { w.pr.head.repo.id = 42; }, /comes from a fork/],
  ["the source run came from a fork", "go", (w) => { w.run.head_repository.id = 42; }, /not a completed same-repository/],
  ["the referenced workflows are not the merge ref", "go", (w) => { w.run.referenced_workflows = referenced(MERGE, "refs/heads/feature"); }, /is not refs\/pull\/156\/merge/],
  ["the referenced workflows disagree on a SHA", "go", (w) => { w.run.referenced_workflows[2] = { ...w.run.referenced_workflows[2], sha: HEAD, path: w.run.referenced_workflows[2].path.replace(MERGE, HEAD) }; }, /disagree on the commit/],
  ["the run never called this lane", "ios", (w) => { w.run.referenced_workflows = w.run.referenced_workflows.filter((r) => !r.path.includes("/ios.yml@")); }, /never called ios\.yml/],
  ["a newer run on the head failed", "go", (w) => { w.runs.push({ ...w.runs[0], id: RUN + 1, created_at: "2026-10-01T14:40:00Z", run_started_at: "2026-10-01T14:40:00Z", conclusion: "failure" }); }, /concluded failure/],
  ["a newer run on the head was cancelled", "go", (w) => { w.runs.push({ ...w.runs[0], id: RUN + 1, created_at: "2026-10-01T14:40:00Z", run_started_at: "2026-10-01T14:40:00Z", conclusion: "cancelled" }); }, /concluded cancelled/],
  ["a run on the head is still pending", "go", (w) => { w.runs.push({ ...w.runs[0], id: RUN + 1, created_at: "2026-10-01T14:40:00Z", run_started_at: "2026-10-01T14:40:00Z", status: "in_progress", conclusion: null }); }, /still in_progress/],
  ["the latest run is a dispatch", "go", (w) => { w.runs.push({ ...w.runs[0], id: RUN + 1, created_at: "2026-10-01T14:40:00Z", run_started_at: "2026-10-01T14:40:00Z", event: "workflow_dispatch" }); }, /is a workflow_dispatch run/],
  ["the source run is a push run (recursive witness)", "go", (w) => { w.runs[0].event = "push"; }, /is a push run/],
  ["the source run is another workflow", "go", (w) => { w.run.path = ".github/workflows/go.yml"; }, /not a completed same-repository pull_request success/],
  ["no merge-gate run exists", "go", (w) => { w.runs = []; }, /no merge-gate run exists/],
  ["the run listing repeats a run", "go", (w) => { w.runs.push({ ...w.runs[0] }); }, /repeats a run/],
  ["the job listing drops its second page", "go", (w) => { w.jobsTotal = w.jobs.length + 100; }, /read \d+ entries, total_count says/],
  ["total_count moves between pages", "go", (w) => {
    w.hooks[`repos/${REPO}/actions/runs/${RUN}/attempts/1/jobs`] = (_, q) => (q.get("page") === "2"
      ? { total_count: w.jobs.length + 1, jobs: page(w.jobs, q) } : undefined);
  }, /total_count moved/],
  ["the job listing repeats a job id", "go", (w) => { w.jobs.splice(5, 0, { ...w.jobs[5] }); }, /repeats a job id/],
  ["a matrix job is missing", "go", (w) => { w.jobs = w.jobs.filter((j) => j.name !== "go / race account shard 7"); }, /no "go \/ race account shard 7"/],
  ["a truncated matrix name is missing", "macos", (w) => { w.jobs = w.jobs.filter((j) => !j.name.endsWith("Re...")); }, /no "macos \/ ui-smoke \(device-inbox/],
  ["the iPad proof is missing", "ios", (w) => { w.jobs = w.jobs.filter((j) => j.name !== "ios / ios-ipad-shell"); }, /no "ios \/ ios-ipad-shell"/],
  ["the iPad job was skipped", "ios", (w) => { w.jobs.find((j) => j.name === "ios / ios-ipad-shell").conclusion = "skipped"; }, /"ios \/ ios-ipad-shell" concluded skipped/],
  ["the lane was not selected", "android", (w) => { w.jobs = w.jobs.filter((j) => !j.name.startsWith("android / ")).concat(job(77, "android", "skipped", [])); }, /no "android \/ build"/],
  ["a job the registry does not know ran", "go", (w) => { w.jobs.push(job(78, "go / mystery", "success", ["ubuntu-latest"])); }, /registry does not know/],
  ["a certify job ran in the source run", "ios", (w) => { const c = w.jobs.find((j) => j.name === "ios / certify-macos"); c.conclusion = "success"; c.labels = ["macos-15"]; },
    /"ios \/ certify-macos" success instead of being skipped/],
  ["a macOS proof ran on Ubuntu", "macos", (w) => { w.jobs.find((j) => j.name === "macos / test").labels = ["ubuntu-latest"]; }, /ran on \[ubuntu-latest\], want \[macos-15\]/],
  ["the source aggregate did not succeed", "go", (w) => { w.jobs.find((j) => j.name === "merge-gate").conclusion = "failure"; }, /merge-gate job did not succeed/],
  ["a source job is still running", "go", (w) => { w.jobs.find((j) => j.name === "windows / build").status = "in_progress"; }, /is in_progress/],
  ["the artifact expired", "go", (w) => { w.artifactPatch = { expired: true }; }, /has expired/],
  ["the artifact was deleted", "go", (w) => { w.hooks[`download:repos/${REPO}/actions/artifacts/${ART}/zip`] = () => { throw new NoReuse("downloading returned HTTP 410"); }; }, /HTTP 410/],
  ["the artifact belongs to another run", "go", (w) => { w.artifactPatch = { workflow_run: { id: RUN + 5, head_sha: HEAD, repository_id: REPO_ID, head_repository_id: REPO_ID } }; }, /is not from merge-gate run/],
  ["the artifact is named for another attempt", "go", (w) => { w.artifactName = "relayium-ci-evidence-proof-attempt-2"; }, /carries 0 artifact\(s\) named relayium-ci-evidence-proof-attempt-1/],
  ["the artifact digest is wrong", "go", (w) => { w.artifactPatch = { digest: `sha256:${"0".repeat(64)}` }; }, /do not match its API digest/],
  ["the artifact has no digest", "go", (w) => { w.artifactPatch = { digest: null }; }, /has no sha256 digest/],
  ["the run is on attempt 2, the proof from attempt 1", "go", (w) => {
    w.run.run_attempt = 2; w.runs[0].run_attempt = 2; w.artifactName = "relayium-ci-evidence-proof-attempt-2";
    w.jobs = w.jobs.map((j) => ({ ...j, run_attempt: 2 }));
  }, /is from run \d+ attempt 1, not \d+\/2/],
  ["the proof is stale", "go", (w) => { w.now = new Date(Date.parse(w.run.updated_at) + 49 * 3600 * 1000); }, /outside 48h/],
  ["the proof is from the future", "go", (w) => { w.now = new Date(Date.parse(w.run.updated_at) - 3600 * 1000); }, /outside 48h/],
  ["the proof is not a merge-gate proof", "go", (w) => rezip(w, (m) => { m.kind = "push-witness"; }), /manifest\.kind is malformed/],
  ["the proof carries an extra key", "go", (w) => rezip(w, (m) => { m.extra = 1; }), /manifest has keys/],
  ["the proof lacks its fingerprints", "go", (w) => rezip(w, (m) => { delete m.fingerprints; }), /manifest has keys/],
  ["the proof's job inventory was edited", "go", (w) => rezip(w, (m) => { m.jobs[3].conclusion = "failure"; }), /job inventory disagrees/],
  ["the proof's fingerprint disagrees", "go", (w) => rezip(w, (m) => { m.fingerprints.go = "f".repeat(64); }), /input fingerprint disagrees/],
  ["the proof was certified by another verifier", "go", (w) => rezip(w, (m) => { m.certification.verifier_sha256 = "e".repeat(64); }), /different verifier/],
  ["the proof says the lane did not run", "go", (w) => rezip(w, (m) => { m.lanes.go = { selected: false, result: "skipped" }; }), /did not run and pass/],
  ["the proof's checkout is not the merge ref", "go", (w) => rezip(w, (m) => { m.checkout.ref = "refs/pull/157/merge"; }), /checkout is not the referenced merge ref/],
  ["the archive holds two entries", "go", (w) => { w.zip = zipOf([{ name: "ci-evidence.json", data: "{}" }, { name: "x", data: "y" }]); }, /holds 2 entries/],
  ["the archive is not JSON", "go", (w) => { w.zip = zipOf([{ name: "ci-evidence.json", data: "{" }]); }, /the proof is not JSON/],
  // The Web job's ACTUALLY tested tag set, not a later snapshot (finding 4).
  ["a tag appears after the Web job's checkout, before the proof", "web", (w) => {
    // The producer's own API snapshot would include it; the job never saw it.
    w.tags.push({ ref: "refs/tags/v0.27.0", object: { sha: hex("new") } });
  }, /tags differ from the tag set web \/ test checked out and tested/],
  ["a tag is moved after the Web job's checkout", "web", (w) => { w.tags[3] = { ...w.tags[3], object: { sha: hex("moved") } }; },
    /tags differ from the tag set web \/ test checked out and tested/],
  ["a tag is deleted after the Web job's checkout", "web", (w) => { w.tags.pop(); }, /tags differ from the tag set/],
  ["the Web job recorded no tag set", "web", (w) => { w.testedTags = null; },
    /carries 0 artifact\(s\) named relayium-ci-evidence-web-tags-attempt-1/],
  ["the tested tag set is from another attempt", "web", (w) => { w.tagsArtifactName = "relayium-ci-evidence-web-tags-attempt-2"; },
    /named relayium-ci-evidence-web-tags-attempt-1, want 1/],
  ["the tested tag set's digest is wrong", "web", (w) => { w.tagsPatch = { digest: `sha256:${"1".repeat(64)}` }; }, /do not match its API digest/],
  ["the tested tag set has a malformed line", "web", (w) => { w.testedTags = "refs/tags/x not-a-sha\n"; }, /malformed line/],
  ["the tested tag set repeats a ref", "web", (w) => { w.testedTags += w.testedTags.split("\n")[0] + "\n"; }, /repeats a ref/],
  ["the tested tag set is from another run", "web", (w) => {
    w.tagsPatch = { workflow_run: { id: RUN + 3, head_sha: HEAD, repository_id: REPO_ID, head_repository_id: REPO_ID } };
  }, /is not from merge-gate run/],
  // Execution freshness, not creation order (finding 2).
  ["an older-created run, re-run later, failed", "go", (w) => {
    w.runs.push({ ...w.runs[0], id: RUN - 7, created_at: "2026-10-01T13:00:00Z", run_started_at: "2026-10-01T14:45:00Z",
      run_attempt: 2, conclusion: "failure" });
  }, /latest merge-gate run on .* concluded failure/],
  ["an older-created run, re-run later, was cancelled", "go", (w) => {
    w.runs.push({ ...w.runs[0], id: RUN - 7, created_at: "2026-10-01T13:00:00Z", run_started_at: "2026-10-01T14:45:00Z",
      run_attempt: 3, conclusion: "cancelled" });
  }, /latest merge-gate run on .* concluded cancelled/],
  ["an older-created run, re-run later, is pending", "go", (w) => {
    w.runs.push({ ...w.runs[0], id: RUN - 7, created_at: "2026-10-01T13:00:00Z", run_started_at: "2026-10-01T14:45:00Z",
      run_attempt: 2, status: "in_progress", conclusion: null });
  }, /still in_progress/],
  ["a listed run has no execution time", "go", (w) => { delete w.runs[0].run_started_at; }, /malformed or for another head/],
  ["the run was re-run after it was listed", "go", (w) => { w.run.run_started_at = "2026-10-01T14:50:00Z"; },
    /the listing said attempt 1 started/],
  ["the listing's attempt disagrees with the run", "go", (w) => { w.runs[0].run_attempt = 2; }, /the listing said attempt 2/],
  ["the source run is re-run while being read", "go", (w) => {
    w.hooks[`repos/${REPO}/actions/workflows/merge-gate.yml/runs`] = (n, q) => (n >= 2
      ? { total_count: 1, workflow_runs: page([{ ...w.runs[0], run_attempt: 2, run_started_at: "2026-10-01T14:51:00Z" }], q) }
      : undefined);
  }, /changed while being verified/],
  ["Web needs its light jobs, the PR skipped them", "web", (w) => { w.jobs.find((j) => j.name === "web / test").conclusion = "skipped"; }, /"web \/ test" concluded skipped/],
  ["two merged PRs claim this commit", "go", (w) => { w.pulls.push({ ...w.pulls[0], number: 157 }); }, /2 merged pull requests produced this commit/],
  // No merged PR ⇒ only the frozen-dispatch source could apply, and a merge commit is not a fast-forward.
  ["no PR produced this commit", "go", (w) => { w.pulls = []; }, /main did not fast-forward by exactly one commit/],
  ["the PR is not merged as this commit", "go", (w) => { w.pr.merge_commit_sha = hex("else"); }, /is not merged into main/],
  ["the API keeps failing", "go", (w) => { w.hooks[`repos/${REPO}/commits/${MAIN}/pulls`] = () => { throw new NoReuse("GET failed after retries (HTTP 502)"); }; }, /failed after retries/],
  ["the source run changes while being read", "go", (w) => {
    w.hooks[`repos/${REPO}/actions/runs/${RUN}`] = (n) => (n >= 2 ? { ...structuredClone(w.run), run_attempt: 2 } : undefined);
  }, /changed while it was being verified/],
  ["a new run appears while being read", "go", (w) => {
    w.hooks[`repos/${REPO}/actions/workflows/merge-gate.yml/runs`] = (n, q) => (n >= 2
      ? { total_count: 2, workflow_runs: page([...w.runs, { ...w.runs[0], id: RUN + 9, created_at: "2026-10-01T14:50:00Z", run_started_at: "2026-10-01T14:50:00Z", status: "queued" }], q) }
      : undefined);
  }, /changed while being verified/],
  ["this run is not the push it claims", "go", (w) => { w.currentPatch = { event: "workflow_dispatch" }; }, /not the main push it claims/],
  ["this run was re-attempted", "go", (w) => { w.currentPatch = { run_attempt: 2 }; }, /not the main push it claims/],
];

for (const [name, laneId, breakIt, expect, envOverrides] of NEGATIVES) {
  const w = freshWorld();
  breakIt(w);
  const r = await runWitness(w, laneId, { ...(laneId === "web" ? { CI_EVIDENCE_SCOPE_LIGHT: "true" } : {}), ...(envOverrides ?? {}) });
  check(!r.ok && r.error instanceof NoReuse && expect.test(r.error.message),
    `"${name}" (lane ${laneId}): want NoReuse matching ${expect}; got ${r.ok ? "REUSE" : `${r.error?.constructor?.name}: ${r.error?.message}`}`);
}

// ── 2b. the frozen release-metadata dispatch: the second, separately named source ──
//
// macos-release.yml dispatches the gate on a frozen candidate: the candidate SHA
// itself, one commit on the current main, on its release-candidate branch; main
// then fast-forwards to exactly that SHA. Minted by the real produceDispatch.

const DRUN = 36990000001;
const FROZEN_BRANCH = "release-candidate/macos-v1.4.5-42-36990000000";
function dispatchBase() {
  const w = baseWorld();
  w.pulls = [];
  w.gitParents = BASE;
  w.run = { ...w.run, id: DRUN, event: "workflow_dispatch", head_sha: MAIN, head_branch: FROZEN_BRANCH,
    referenced_workflows: referenced(MAIN, `refs/heads/${FROZEN_BRANCH}`) };
  w.runs = [];
  w.mainRuns = [{ id: DRUN, head_sha: MAIN, created_at: "2026-10-01T14:06:59Z", run_started_at: "2026-10-01T14:06:59Z",
    run_attempt: 1, event: "workflow_dispatch", status: "completed", conclusion: "success", head_branch: FROZEN_BRANCH }];
  w.mergeCommit = { sha: MAIN, tree: { sha: TREE }, parents: [{ sha: BASE }] };
  // A complete release-metadata candidate by BASE's own whitelist, and the
  // branch's version in its native-releases manifest.
  w.compare = { status: "ahead", ahead_by: 1, behind_by: 0, files: CANDIDATE_PATHS.map((filename) => ({ filename })) };
  w.files = { [NATIVE_RELEASES_FILE]: JSON.stringify({ macos: { available: true, version: "1.4.5", build: 42 } }) };
  w.certSha = MAIN;
  w.certRef = `refs/heads/${FROZEN_BRANCH}`;
  return w;
}
const dispatchEnv = (patch = {}) => produceEnv({
  GITHUB_EVENT_NAME: "workflow_dispatch", GITHUB_REF: `refs/heads/${FROZEN_BRANCH}`, GITHUB_SHA: MAIN, GITHUB_WORKFLOW_SHA: MAIN,
  GITHUB_RUN_ID: String(DRUN), GITHUB_WORKFLOW_REF: `${REPO}/.github/workflows/merge-gate.yml@refs/heads/${FROZEN_BRANCH}`,
  CI_EVIDENCE_DISPATCH_MODE: "frozen-release-metadata", CI_EVIDENCE_DISPATCH_BASE: BASE, CI_EVIDENCE_DISPATCH_HEAD: MAIN, ...patch,
});
async function mintDispatch(world, envPatch, git) {
  const { loadScope, ...w } = world;
  const pw = producerWorld(w);
  return produce({ env: dispatchEnv(envPatch), api: mockApi(pw), git: git ?? gitFor(pw, MAIN), registry: REGISTRY,
    now: () => new Date("2026-10-01T14:29:30Z"), workflowsDir, readFile: worldReadFile(pw), ...(loadScope ? { loadScope } : {}) });
}
const dispatchManifest = await mintDispatch(dispatchBase());
check(dispatchManifest.kind === "merge-gate-frozen-dispatch-full-run" && dispatchManifest.pull_request === null
  && dispatchManifest.dispatch.base_sha === BASE && dispatchManifest.dispatch.head_sha === MAIN
  && dispatchManifest.checkout.parents.join() === BASE && dispatchManifest.checkout.ref === `refs/heads/${FROZEN_BRANCH}`,
`produceDispatch did not record the frozen candidate, its base and branch: ${JSON.stringify(dispatchManifest).slice(0, 300)}`);
const dispatchWorld = (patchManifest) => {
  const w = dispatchBase();
  const m = structuredClone(dispatchManifest);
  if (patchManifest) patchManifest(m);
  w.zip = zipManifest(m);
  return w;
};
for (const laneId of LANE_IDS.filter((id) => !UNCERTIFIABLE_LANES.includes(id))) {
  const r = await runWitness(dispatchWorld(), laneId, laneId === "web" ? { CI_EVIDENCE_SCOPE_LIGHT: "true" } : {});
  check(r.ok && r.witness.source.kind === "merge-gate-frozen-dispatch-full-run" && r.witness.source.pull_request === null
    && r.witness.source.merge_sha === MAIN && r.witness.source.run_id === DRUN,
  `lane ${laneId}: the consistent frozen-dispatch world was refused or mis-recorded: ${r.error?.message ?? JSON.stringify(r.witness?.source)}`);
}

for (const [name, envPatch, worldPatch, expect] of [
  ["a pull-request mode dispatch", { CI_EVIDENCE_DISPATCH_MODE: "pull-request" }, null, /only frozen-release-metadata does/],
  ["a development branch", { GITHUB_REF: "refs/heads/feature/x" }, null, /is not a frozen release-candidate branch/],
  ["a candidate two commits on its base", {}, (w) => { w.gitParents = `${BASE} ${HEAD}`; }, /not exactly one commit on the dispatched base/],
  ["a base that is no longer main", {}, (w) => { w.mainRef = { object: { sha: hex("moved-main") } }; }, /not the candidate's base/],
  ["a candidate that edits a workflow", {}, (w) => { w.compare.files.push({ filename: ".github/workflows/web.yml" }); }, /touches ".github\/workflows\/web.yml", a gate input/],
  ["a candidate that edits a script", {}, (w) => { w.compare.files = [{ filename: "web/a.json", previous_filename: "scripts/ci/x.sh" }]; }, /touches "scripts\/ci\/x.sh"/],
  ["a candidate that edits the selector fixture", {}, (w) => { w.compare.files.push({ filename: "scripts/test/fixtures/ci-path-selection.mjs" }); }, /a gate input/],
  ["a compare of two commits", {}, (w) => { w.compare.ahead_by = 2; }, /exactly one commit of a bounded change/],
  ["a compare at the 300-file cap", {}, (w) => { w.compare.files = Array.from({ length: 300 }, (_, i) => ({ filename: `web/f${i}` })); }, /bounded change/],
  ["a run on another branch than the runner says", {}, (w) => { w.run.head_branch = "release-candidate/macos-v1.4.5-42-1"; }, /disagrees with the runner's/],
  ["referenced workflows from another commit", {}, (w) => { w.run.referenced_workflows = referenced(HEAD, `refs/heads/${FROZEN_BRANCH}`); }, /referenced workflows ran/],
]) {
  const w = dispatchBase();
  if (worldPatch) worldPatch(w);
  let got = null;
  try { await mintDispatch(w, envPatch); } catch (err) { got = err; }
  check(got instanceof NoReuse && expect.test(got.message), `produceDispatch with ${name}: want NoReuse ${expect}, got ${got?.message ?? "a manifest"}`);
}

for (const [name, laneId, breakIt, expect, envOverrides] of [
  ["main moved from another base", "go", null, /main did not fast-forward by exactly one commit/,
    { GITHUB_EVENT_PATH: writeJson("push-dispatch-other.json", { ref: "refs/heads/main", after: MAIN, before: hex("other-base"), created: false, deleted: false, forced: false, repository: { id: REPO_ID } }) }],
  ["an associated but unmerged pull request", "go", (w) => { w.pulls = [{ number: 9, merged_at: null, merge_commit_sha: hex("x"), base: { ref: "main", repo: { id: REPO_ID } } }]; },
    /pull request\(s\) are associated with this commit but none merged it/],
  ["the latest dispatch on main failed", "go", (w) => { w.mainRuns[0].conclusion = "failure"; }, /concluded failure/],
  ["a later dispatch on main is pending", "go", (w) => { w.mainRuns.push({ ...w.mainRuns[0], id: DRUN + 1, run_started_at: "2026-10-01T14:40:00Z", status: "in_progress", conclusion: null }); }, /still in_progress/],
  ["an older dispatch re-run later failed", "go", (w) => { w.mainRuns.push({ ...w.mainRuns[0], id: DRUN - 1, created_at: "2026-10-01T13:00:00Z", run_started_at: "2026-10-01T14:45:00Z", run_attempt: 2, conclusion: "failure" }); }, /concluded failure/],
  ["a dispatch from a development branch", "go", (w) => { w.mainRuns[0].head_branch = "feature/x"; }, /not a frozen release-candidate branch/],
  ["referenced workflows on another ref", "go", (w) => { w.run.referenced_workflows = referenced(MAIN, "refs/heads/release-candidate/macos-v1.4.5-42-999"); }, /is not refs\/heads\/release-candidate\/macos-v1\.4\.5-42-36990000000/],
  ["a pull-request proof on a dispatch source", "go", (w) => { w.zip = zipManifest(manifest); }, /the proof is a merge-gate-pull-request-full-run, this commit's source is a merge-gate-frozen-dispatch-full-run/],
  ["a proof naming another base", "go", (w) => { const m = structuredClone(dispatchManifest); m.dispatch.base_sha = hex("b2"); w.zip = zipManifest(m); }, /names another candidate, base or branch/],
  ["certificates bound to a pull request ref", "go", (w) => { w.certRef = `refs/pull/${PR}/merge`; }, /is not go\/test entry 0/],
  ["a commit the API says has two parents", "go", (w) => { w.mergeCommit.parents.push({ sha: HEAD }); }, /not the candidate on its base/],
]) {
  const w = dispatchWorld();
  if (breakIt) breakIt(w);
  const r = await runWitness(w, laneId, envOverrides ?? {});
  check(!r.ok && r.error instanceof NoReuse && expect.test(r.error.message),
    `dispatch "${name}" (lane ${laneId}): want NoReuse ${expect}; got ${r.ok ? "REUSE" : r.error?.message}`);
}
{
  // Both kinds of source at once is ambiguous: a merged PR's commit that is also a dispatch head.
  const w = freshWorld();
  w.mainRuns = dispatchBase().mainRuns;
  const r = await runWitness(w, "go");
  check(!r.ok && /two kinds of source is ambiguous/.test(r.error?.message ?? ""), `a commit with both sources was ${r.ok ? "REUSED" : `refused for ${r.error?.message}`}`);
}

// ── 2c. the frozen candidate's scope: BASE's whitelist, judged by BOTH sides ──
//
// The mode name proves nothing and neither does protected main: an
// independently verified finding was a REAL produce() minting a frozen-dispatch
// proof for a candidate whose only changes were app code, web app code and
// go.mod. Producer and consumer each re-judge the candidate's complete change
// set with BASE's release-metadata whitelist (exactly CANDIDATE_PATHS, plus
// only the optional sitemap) and its manifest version against the branch.

check(FROZEN_REF.source === CANDIDATE_REF.source,
  `FROZEN_REF (${FROZEN_REF.source}) is not the macOS release lane's CANDIDATE_REF (${CANDIDATE_REF.source}) source for source`);
check(dispatchManifest.dispatch.version === "1.4.5" && JSON.stringify(dispatchManifest.dispatch.paths) === JSON.stringify([...CANDIDATE_PATHS].sort())
  && /^[0-9a-f]{64}$/.test(dispatchManifest.dispatch.scope_sha256),
`the dispatch proof does not record the judged version, change set and whitelist digest: ${JSON.stringify(dispatchManifest.dispatch).slice(0, 300)}`);
{
  const w = dispatchBase();
  w.compare.files.push(...OPTIONAL_GENERATED_PAGES.map((filename) => ({ filename })));
  let m = null;
  try { m = await mintDispatch(w); } catch (err) { check(false, `a complete candidate with the optional sitemap was refused: ${err.message}`); }
  if (m) check(m.dispatch.paths.includes("web/public/sitemap.xml"), "the optional sitemap was accepted but not recorded");
}
const files = (...names) => (w) => { w.compare.files = names.map((filename) => ({ filename })); };
const plus = (...names) => (w) => { w.compare.files.push(...names.map((filename) => ({ filename }))); };
const ARCHIVED_RELEASE_PAGE = "web/public/de/releases/index.html";
const SCOPE_REFUSALS = [
  ["only app code, web app code and go.mod (the verified finding)", files("apps/mac/Relayium/AppDelegate.swift", "web/src/App.svelte", "go.mod"), /whitelist refuses the candidate/],
  ["only the macOS AppDelegate", files("apps/mac/Relayium/AppDelegate.swift"), /whitelist refuses the candidate/],
  ["only the web app", files("web/src/App.svelte"), /whitelist refuses the candidate/],
  ["only go.mod", files("go.mod"), /whitelist refuses the candidate/],
  ["only the README", files("README.md"), /the release candidate is incomplete/],
  ["a complete candidate plus server code", plus("server/account/session.go"), /changes unrelated files: server\/account\/session\.go/],
  ["a complete candidate plus the web app", plus("web/src/App.svelte"), /changes unrelated files: web\/src\/App\.svelte/],
  ["a complete candidate plus the macOS app", plus("apps/mac/Relayium/AppDelegate.swift"), /changes unrelated files: apps\/mac\/Relayium\/AppDelegate\.swift/],
  ["a complete candidate plus user code renamed into a whitelisted path", (w) => { w.compare.files[0].previous_filename = "server/usercode/x.go"; },
    /changes unrelated files: server\/usercode\/x\.go/],
  ["a complete candidate plus an archived locale's release page", plus(ARCHIVED_RELEASE_PAGE), /archived locales must stay byte-for-byte unchanged/],
  ["a candidate without its native-releases manifest", (w) => { w.compare.files = w.compare.files.filter((f) => f.filename !== NATIVE_RELEASES_FILE); },
    /the release candidate is incomplete: .*web\/native-releases\.json/],
  ["a candidate that rewrites its own whitelist", plus(SCOPE_FILE), /changes web\/scripts\/macos-release-candidate\.mjs, the whitelist that judges it/],
  ["a whitelist here that is not BASE's", (w) => { w.scopeBlob = { ...SCOPE_BLOB, sha: hex("other-whitelist") }; }, /is not BASE [0-9a-f]{40}'s/],
  ["a manifest naming another version than its branch", (w) => { w.files[NATIVE_RELEASES_FILE] = JSON.stringify({ macos: { version: "1.4.4", build: 41 } }); },
    /names macOS "1\.4\.4", its branch 1\.4\.5/],
  ["an unreadable manifest", (w) => { w.files[NATIVE_RELEASES_FILE] = "{"; }, /web\/native-releases\.json is unreadable/],
  ["a whitelist module that cannot judge", (w) => { w.loadScope = async () => ({}); }, /does not export the release-metadata whitelist/],
  ["a whitelist module that throws", (w) => { w.loadScope = async () => { throw new Error("boom"); }; }, /could not judge the candidate: boom/],
];
for (const [name, breakIt, expect] of SCOPE_REFUSALS) {
  const w = dispatchBase();
  breakIt(w);
  let got = null;
  try { await mintDispatch(w); } catch (err) { got = err; }
  check(got instanceof NoReuse && expect.test(got.message), `produceDispatch with ${name}: want NoReuse ${expect}, got ${got?.message ?? "a manifest"}`);
}
// The consumer judges on its own. A proof whose recorded scope AGREES with the
// compare API is still refused when BASE's whitelist refuses that change set —
// so the refusal is the consumer's own judgement, not a mismatch with the proof.
for (const [name, breakIt, expect] of SCOPE_REFUSALS) {
  const w = dispatchWorld((m) => {
    const probe = dispatchBase();
    breakIt(probe);
    m.dispatch.paths = [...new Set(probe.compare.files.flatMap((f) => [f.filename, f.previous_filename]).filter(Boolean))].sort();
  });
  breakIt(w);
  const r = await runWitness(w, "web", { CI_EVIDENCE_SCOPE_LIGHT: "true" });
  check(!r.ok && r.error instanceof NoReuse && expect.test(r.error.message),
    `the consumer with ${name}: want its own NoReuse ${expect}; got ${r.ok ? "REUSE" : r.error?.message}`);
}
for (const [name, patch, expect] of [
  ["a proof recording another change set", (m) => { m.dispatch.paths = [...m.dispatch.paths, "web/public/sitemap.xml"].sort(); }, /candidate scope .* disagrees/],
  ["a proof recording another version", (m) => { m.dispatch.version = "1.4.6"; }, /candidate scope .* disagrees/],
  ["a proof judged by another whitelist", (m) => { m.dispatch.scope_sha256 = "e".repeat(64); }, /candidate scope .* disagrees/],
  ["a proof without its scope", (m) => { delete m.dispatch.scope_sha256; }, /manifest\.dispatch is malformed/],
]) {
  const r = await runWitness(dispatchWorld(patch), "go");
  check(!r.ok && r.error instanceof NoReuse && expect.test(r.error.message), `the consumer with ${name}: want NoReuse ${expect}; got ${r.ok ? "REUSE" : r.error?.message}`);
}

// ── 2d. the screen: enables paid probes, approves nothing ───────────────────
{
  for (const [what, world, laneId, env] of [["a pull request source", freshWorld(), "ios", {}], ["a frozen dispatch source", dispatchWorld(), "web", { CI_EVIDENCE_SCOPE_LIGHT: "true" }]]) {
    world.screen = true;
    world.noCurrentCerts = true;
    const r = await runWitness(world, laneId, env);
    check(r.ok && r.witness?.eligible === true, `the screen refused ${what} that only lacks current certificates: ${r.error?.message}`);
  }
  // Eligible is not approval: the same world without current certificates is never reused.
  const w = freshWorld();
  w.noCurrentCerts = true;
  const r = await runWitness(w, "ios");
  check(!r.ok && /no current toolchain certificates were captured/.test(r.error?.message ?? ""), `a screened-eligible world without current certificates was ${r.ok ? "REUSED" : r.error?.message}`);
  for (const [name, breakIt, laneId, expect] of [
    ["no merged pull request and no dispatch", (x) => { x.pulls = []; }, "ios", /main did not fast-forward|no merge-gate run exists/],
    ["the source run's latest attempt failed", (x) => { x.runs[0].conclusion = "failure"; }, "ios", /concluded failure/],
    ["a missing source certificate", (x) => { x.certPatch["ios/ios-ipad-shell/0"] = () => null; }, "ios", /carries 0 artifact\(s\) named relayium-ci-evidence-toolchain-ios-ios-ipad-shell-0-attempt-1/],
    ["a source certificate from another job", (x) => { x.certPatch["ios/ios-build/0"] = (c) => ({ ...c, binding: { ...c.binding, job: "ios-ui-smoke" } }); }, "ios", /is not ios\/ios-build entry 0/],
    ["an uncertifiable lane", () => {}, UNCERTIFIABLE_LANES[0], /is uncertifiable/],
    ["a source run that RAN its screen", (x) => { x.jobs.find((j) => j.name === "ios / screen").conclusion = "success"; }, "ios", /"ios \/ screen" success instead of being skipped/],
  ]) {
    const x = freshWorld();
    breakIt(x);
    x.screen = true;
    x.noCurrentCerts = true;
    const got = await runWitness(x, laneId);
    check(!got.ok && got.error instanceof NoReuse && expect.test(got.error.message), `the screen with ${name}: want NoReuse ${expect}; got ${got.ok ? "ELIGIBLE" : got.error?.message}`);
  }
  // The command: always exit 0; anything but a verified screen is eligible=false (no paid probe).
  const lines = [];
  const sink = { write: (t) => { lines.push(t); return true; } };
  const pr = { ...pushEnv("ios"), GITHUB_EVENT_NAME: "pull_request" };
  const code = await main(["screen", "ios"], pr, sink, { api: mockApi(freshWorld()), git: gitFor(freshWorld(), MAIN), now: () => NOW, workflowsDir });
  check(code === 0 && /^eligible=false\nreason=event pull_request never reuses/.test(lines.join("")), `screen on a pull request printed ${JSON.stringify(lines.join(""))} (exit ${code})`);
  lines.length = 0;
  const fw = freshWorld();
  fw.current = { ...fw.current, path: ".github/workflows/ios.yml" };
  const code2 = await main(["screen", "ios"], pushEnv("ios"), sink, { api: mockApi(fw), git: gitFor(fw, MAIN), now: () => NOW, workflowsDir });
  check(code2 === 0 && lines.join("").startsWith("eligible=true\n"), `screen on a consistent main push printed ${JSON.stringify(lines.join(""))} (exit ${code2})`);
  lines.length = 0;
  const code3 = await main(["screen", "ios"], pushEnv("ios"), sink, { api: { json: async () => { throw new Error("socket hang up"); }, download: async () => { throw new Error("x"); } },
    git: gitFor(fw, MAIN), now: () => NOW, workflowsDir });
  check(code3 === 0 && /^eligible=false\nreason=unexpected: Error: socket hang up/.test(lines.join("")), `a screen whose API failed printed ${JSON.stringify(lines.join(""))} (exit ${code3})`);
}

// The event gate: only an ordinary push to main, by this lane's own workflow.
for (const [name, overrides, expect] of [
  ["a pull_request run", { GITHUB_EVENT_NAME: "pull_request" }, /never reuses/],
  ["a dispatch", { GITHUB_EVENT_NAME: "workflow_dispatch" }, /never reuses/],
  ["a push to another branch", { GITHUB_REF: "refs/heads/feature" }, /is not refs\/heads\/main/],
  ["a called run (the release caller)", { GITHUB_WORKFLOW_REF: `${REPO}/.github/workflows/macos-release.yml@refs/heads/main` }, /a called or renamed run/],
  ["a push whose payload is for another commit", { GITHUB_EVENT_PATH: writeJson("push-other.json", { ref: "refs/heads/main", after: hex("z"), created: false, deleted: false, forced: false, repository: { id: REPO_ID } }) }, /not an ordinary fast-forward/],
  ["a force push", { GITHUB_EVENT_PATH: writeJson("push-forced.json", { ref: "refs/heads/main", after: MAIN, created: false, deleted: false, forced: true, repository: { id: REPO_ID } }) }, /not an ordinary fast-forward/],
]) {
  const r = await runWitness(freshWorld(), "go", overrides);
  check(!r.ok && expect.test(r.error?.message ?? ""), `"${name}" was not refused by the event gate: ${r.ok ? "REUSE" : r.error?.message}`);
  check(r.api.calls.size === 0, `"${name}": the API was queried before the event gate refused`);
}

// Web: the PR legitimately skipped its light jobs, and main does not need them either.
{
  // The PR's own scope skipped them, so its proof says so too: mint from that world.
  const w = baseWorld();
  for (const name of ["web / test", "web / windows-temporary-downloader"]) w.jobs.find((j) => j.name === name).conclusion = "skipped";
  w.zip = zipManifest(await mint(w));
  const ok = await runWitness(w, "web", { CI_EVIDENCE_SCOPE_LIGHT: "false" });
  check(ok.ok && !ok.witness.jobs.test && !ok.witness.jobs["windows-temporary-downloader"] && ok.witness.jobs["mixed-link-e2e"],
    `Web with light=false on both sides was refused or vouched for a gated job: ${ok.error?.message ?? JSON.stringify(ok.witness?.jobs)}`);
  const unknown = await runWitness(w, "web", {});
  check(!unknown.ok && /"web \/ test" concluded skipped/.test(unknown.error.message),
    "Web with an UNKNOWN main scope reused a run that skipped the light jobs; unknown must mean required");
}
// Web: when main does not need the tag-reading job, tag drift is not this proof's concern —
// and when it does, the drift is refused even with a fresh producer-time snapshot.
{
  const w = baseWorld();
  for (const name of ["web / test", "web / windows-temporary-downloader"]) w.jobs.find((j) => j.name === name).conclusion = "skipped";
  w.testedTags = null;
  w.zip = zipManifest(await mint(w));
  w.tags.push({ ref: "refs/tags/v0.27.0", object: { sha: hex("new") } });
  const notNeeded = await runWitness(w, "web", { CI_EVIDENCE_SCOPE_LIGHT: "false" });
  check(notNeeded.ok, `Web with light=false refused over a tag the skipped test job never read: ${notNeeded.error?.message}`);
  const tagged = freshWorld();
  const ok = await runWitness(tagged, "web", { CI_EVIDENCE_SCOPE_LIGHT: "true" });
  check(ok.ok && ok.api.calls.get(`repos/${REPO}/actions/artifacts/${TAGS_ART}/zip`) === 1,
    `Web with an unchanged tag set did not read the job's own tested-tag artifact: ${ok.error?.message}`);
  const empty = freshWorld();
  empty.tags = [];
  empty.testedTags = "";
  const none = await runWitness(empty, "web", { CI_EVIDENCE_SCOPE_LIGHT: "true" });
  check(none.ok, `Web with no tags anywhere was refused: ${none.error?.message}`);
}
// A re-run gate (attempt 2): the tags the Web job tested IN THAT ATTEMPT decide,
// never a set left behind by attempt 1.
{
  const second = () => {
    const w = baseWorld();
    w.run.run_attempt = 2;
    w.runs[0].run_attempt = 2;
    w.jobs = w.jobs.map((j) => ({ ...j, run_attempt: 2 }));
    w.artifactName = "relayium-ci-evidence-proof-attempt-2";
    w.tagsArtifactName = "relayium-ci-evidence-web-tags-attempt-2";
    w.certAttempt = 2;
    return w;
  };
  const w2 = second();
  w2.zip = zipManifest(await mint(w2, produceEnv({ GITHUB_RUN_ATTEMPT: "2" })));
  const ok = await runWitness(w2, "web", { CI_EVIDENCE_SCOPE_LIGHT: "true" });
  check(ok.ok && ok.witness.source.run_attempt === 2, `Web on a consistent attempt-2 proof was refused: ${ok.error?.message}`);
  const stale = second();
  stale.zip = w2.zip;
  stale.tagsArtifactName = "relayium-ci-evidence-web-tags-attempt-1";
  const r = await runWitness(stale, "web", { CI_EVIDENCE_SCOPE_LIGHT: "true" });
  check(!r.ok && /0 artifact\(s\) named relayium-ci-evidence-web-tags-attempt-2/.test(r.error?.message ?? ""),
    `Web reused attempt 2 against attempt 1's tested tag set: ${r.ok ? "REUSE" : r.error?.message}`);
}
check(JSON.stringify(Object.keys(requiredJobs(REGISTRY.lanes.web, "false")).sort())
  === JSON.stringify(["device-inbox-e2e", "mixed-link-e2e", "scope", "sealed-box-interop"]),
"requiredJobs(web, light=false) is not exactly the ungated jobs");

// ── 2e. actions/checkout's real depth-1 clone, through the real git adapter ──
//
// The gate and every main push check out ONE commit: its parents are shallow
// boundaries and `git show --format=%P` reports none, which once refused every
// genuine candidate ("not exactly one commit on the dispatched base"). The raw
// commit header still names them. Each case below clones the world's own
// commits with `--depth 1` over file:// and drives produce and witness through
// `realGit` against the matching API world.

function shallowClone(branch) {
  const dir = mkdtempSync(join(tmp, `shallow-${branch}-`));
  fixtureGit(["clone", "-q", "--depth", "1", "--no-tags", "--branch", branch, `file://${ORIGIN}`, dir], tmp);
  return dir;
}
const CLONES = Object.fromEntries(["base", "head", "merge", "main"].map((b) => [b, shallowClone(b)]));
const realAt = (dir) => (args) => realGit(args, dir);
const refusal = async (fn) => { try { await fn(); return null; } catch (err) { return err; } };

for (const [branch, sha, parents] of [["merge", MERGE, [BASE, HEAD]], ["main", MAIN, [BASE]], ["head", HEAD, [BASE]]]) {
  const dir = CLONES[branch];
  const shallow = realGit(["rev-parse", "--is-shallow-repository"], dir).toString().trim();
  const listed = realGit(["show", "-s", "--format=%P", "HEAD"], dir).toString().trim();
  check(shallow === "true" && listed === "", `the ${branch} clone is not the depth-1 shape it stands for (shallow ${shallow}, %P "${listed}")`);
  let facts;
  try { facts = headFacts(realAt(dir)); } catch (err) { facts = { error: err.message }; }
  check(facts.sha === sha && facts.tree === TREE && facts.parents.join() === parents.join(),
    `headFacts read the depth-1 ${branch} clone as ${JSON.stringify(facts)}; want ${sha} on [${parents.join(", ")}]`);
}
{
  let facts;
  try { facts = headFacts(realAt(CLONES.base)); } catch (err) { facts = { error: err.message }; }
  check(facts.sha === BASE && facts.parents?.length === 0, `headFacts read the root commit as ${JSON.stringify(facts)}`);
}

// The producer, both kinds of proof.
// A refusal here is recorded, and the consumer then judges the mock-minted proof of the same world.
const mintedOr = async (mintIt, fallback, what) => {
  try { return await mintIt(); } catch (err) { check(false, `${what} was refused: ${err.message}`); return fallback; }
};
const shallowPull = await mintedOr(() => produce({ env: produceEnv(), api: mockApi(producerWorld(baseWorld())), git: realAt(CLONES.merge),
  registry: REGISTRY, now: () => new Date("2026-10-01T14:29:30Z"), workflowsDir }), manifest, "the pull-request proof from a depth-1 merge checkout");
check(shallowPull.checkout.sha === MERGE && shallowPull.checkout.tree === TREE && shallowPull.checkout.parents.join() === `${BASE},${HEAD}`,
  `the pull-request proof from a depth-1 merge checkout recorded ${JSON.stringify(shallowPull.checkout)}`);
const shallowDispatch = await mintedOr(() => mintDispatch(dispatchBase(), {}, realAt(CLONES.main)), dispatchManifest,
  "the frozen proof from a depth-1 candidate checkout");
check(shallowDispatch.checkout.sha === MAIN && shallowDispatch.checkout.parents.join() === BASE
  && shallowDispatch.dispatch.base_sha === BASE && shallowDispatch.dispatch.head_sha === MAIN,
`the frozen proof from a depth-1 candidate checkout recorded ${JSON.stringify(shallowDispatch.checkout)}`);

// The consumer: a depth-1 main push witnesses the frozen candidate's proof.
const shallowDispatchWorld = () => { const w = dispatchBase(); w.zip = zipManifest(shallowDispatch); w.git = realAt(CLONES.main); return w; };
for (const laneId of LANE_IDS.filter((id) => !UNCERTIFIABLE_LANES.includes(id))) {
  const r = await runWitness(shallowDispatchWorld(), laneId, laneId === "web" ? { CI_EVIDENCE_SCOPE_LIGHT: "true" } : {});
  check(r.ok && r.witness.source.kind === "merge-gate-frozen-dispatch-full-run" && r.witness.target.sha === MAIN
    && r.witness.target.tree === TREE,
  `lane ${laneId}: a depth-1 main push refused the genuine frozen candidate: ${r.error?.message ?? JSON.stringify(r.witness?.source)}`);
}
{
  const w = baseWorld();
  w.zip = zipManifest(shallowPull);
  w.git = realAt(CLONES.main);
  const r = await runWitness(w, "go");
  check(r.ok && r.witness.source.merge_sha === MERGE, `a depth-1 main push refused the pull-request proof: ${r.error?.message}`);
}

// Still strict: the real ancestry, not a substituted one, must be exactly right.
for (const [name, clone, run, expect] of [
  ["a frozen candidate on another base", "main", () => mintDispatch(dispatchBase(), { CI_EVIDENCE_DISPATCH_BASE: HEAD }, realAt(CLONES.main)),
    /not exactly one commit on the dispatched base/],
  ["a two-parent frozen candidate", "merge", () => mintDispatch(dispatchBase(), { GITHUB_SHA: MERGE, GITHUB_WORKFLOW_SHA: MERGE,
    CI_EVIDENCE_DISPATCH_HEAD: MERGE }, realAt(CLONES.merge)), /not exactly one commit on the dispatched base/],
  ["a root frozen candidate", "base", () => mintDispatch(dispatchBase(), { GITHUB_SHA: BASE, GITHUB_WORKFLOW_SHA: BASE,
    CI_EVIDENCE_DISPATCH_HEAD: BASE, CI_EVIDENCE_DISPATCH_BASE: HEAD }, realAt(CLONES.base)), /not exactly one commit on the dispatched base/],
  ["a frozen checkout of another commit", "merge", () => mintDispatch(dispatchBase(), {}, realAt(CLONES.merge)), /checked out .*, the dispatch is for/],
  ["a pull-request proof from a one-parent checkout", "main", () => produce({ env: produceEnv({ GITHUB_SHA: MAIN, GITHUB_WORKFLOW_SHA: MAIN }),
    api: mockApi(producerWorld(baseWorld())), git: realAt(CLONES.main), registry: REGISTRY, now: () => NOW, workflowsDir }),
  /not a two-parent merge commit/],
  ["a pull-request proof from a root checkout", "base", () => produce({ env: produceEnv({ GITHUB_SHA: BASE, GITHUB_WORKFLOW_SHA: BASE }),
    api: mockApi(producerWorld(baseWorld())), git: realAt(CLONES.base), registry: REGISTRY, now: () => NOW, workflowsDir }),
  /not a two-parent merge commit/],
  ["a pull-request proof whose second parent is not the head", "merge", () => produce({
    env: produceEnv({ GITHUB_EVENT_PATH: writeJson("pr-event-other-head.json", { pull_request: { number: PR, head: { sha: MAIN, repo: { id: REPO_ID } },
      base: { sha: BASE, ref: "main", repo: { id: REPO_ID } } } }) }),
    api: mockApi(producerWorld(baseWorld())), git: realAt(CLONES.merge), registry: REGISTRY, now: () => NOW, workflowsDir }),
  /second parent is not the pull request head/],
  ["a main push from another base", "main", async () => {
    const r = await runWitness(shallowDispatchWorld(), "go", { GITHUB_EVENT_PATH: writeJson("push-shallow-other-base.json",
      { ref: "refs/heads/main", after: MAIN, before: HEAD, created: false, deleted: false, forced: false, repository: { id: REPO_ID } }) });
    if (!r.ok) throw r.error;
  }, /main did not fast-forward by exactly one commit/],
  ["a main push of a two-parent commit", "merge", async () => {
    const w = shallowDispatchWorld();
    w.git = realAt(CLONES.merge);
    const r = await runWitness(w, "go");
    if (!r.ok) throw r.error;
  }, /checked out .*, the push is/],
]) {
  const got = await refusal(run);
  check(got instanceof NoReuse && expect.test(got.message),
    `depth-1 ${clone} clone, ${name}: want NoReuse ${expect}; got ${got ? got.message : "acceptance"}`);
}

// A header git itself does not write: refused, never repaired. Real objects,
// stored without git's own checks, at a detached HEAD of a full repository.
{
  const dir = mkdtempSync(join(tmp, "malformed-"));
  fixtureGit(["clone", "-q", `file://${ORIGIN}`, dir], tmp);
  const author = "author t <t@t> 1790000000 +0000\ncommitter t <t@t> 1790000000 +0000\n";
  for (const [name, raw, expect] of [
    ["a parent line after the committer", `tree ${TREE}\nparent ${BASE}\n${author}parent ${HEAD}\n\nx\n`, /header is malformed/],
    ["no committer", `tree ${TREE}\nparent ${BASE}\nauthor t <t@t> 1790000000 +0000\n\nx\n`, /header is malformed/],
    ["a second tree", `tree ${TREE}\ntree ${TREE}\nparent ${BASE}\n${author}\nx\n`, /header is malformed/],
  ]) {
    const sha = fixtureGit(["hash-object", "-t", "commit", "--literally", "-w", "--stdin"], dir, raw);
    fixtureGit(["update-ref", "--no-deref", "HEAD", sha], dir);
    const got = await refusal(() => headFacts(realAt(dir)));
    check(got instanceof NoReuse && expect.test(got.message), `a real commit with ${name}: want NoReuse ${expect}; got ${got ? got.message : "acceptance"}`);
  }
}

// The same header rules on the mock, for shapes real git cannot be made to print.
for (const [name, raw, expect] of [
  ["a header naming another tree", rawCommit(hex("another-tree"), [BASE]), /does not open with its tree/],
  ["a short parent", rawCommit(TREE, [BASE.slice(0, 12)]), /malformed parent line/],
  ["an upper-case parent", rawCommit(TREE, [BASE.toUpperCase()]), /malformed parent line/],
  ["no blank line after the header", rawCommit(TREE, [BASE]).replace("\n\n", "\n"), /has no header/],
  ["a header that opens with a parent", `parent ${BASE}\ntree ${TREE}\nauthor a\ncommitter c\n\nx\n`, /does not open with its tree/],
]) {
  const got = await refusal(() => headFacts(gitFor({ gitTree: TREE, gitRaw: raw }, MAIN)));
  check(got instanceof NoReuse && expect.test(got.message), `a mock commit with ${name}: want NoReuse ${expect}; got ${got ? got.message : "acceptance"}`);
}

// ── 3. produce, confirm, the archive and the schema ─────────────────────────

for (const [name, mutateEnv, mutateWorld, expect] of [
  ["a push event", (e) => { e.GITHUB_EVENT_NAME = "push"; }, null, /produces no proof/],
  ["a job still running", null, (w) => { w.jobs.find((j) => j.name === "go / test").status = "in_progress"; }, /has not completed/],
  ["referenced workflows from another commit", null, (w) => { w.run.referenced_workflows = referenced(HEAD); }, /referenced workflows ran/],
  ["a fork pull request", (e) => {
    e.GITHUB_EVENT_PATH = writeJson("pr-fork.json", { pull_request: { number: PR, head: { sha: HEAD, repo: { id: 7 } }, base: { sha: BASE, ref: "main", repo: { id: REPO_ID } } } });
  }, null, /fork pull request produces no proof/],
  ["a failed selected lane", (e) => { const n = JSON.parse(e.CI_EVIDENCE_NEEDS); n.go.result = "failure"; e.CI_EVIDENCE_NEEDS = JSON.stringify(n); }, null, /lane go is selected=true with result failure/],
  ["an unreadable selection", (e) => { const s = JSON.parse(e.CI_EVIDENCE_SELECTED); s.ios = "maybe"; e.CI_EVIDENCE_SELECTED = JSON.stringify(s); }, null, /selection of ios/],
  ["a checkout that is not the run's commit", (e) => { e.GITHUB_SHA = HEAD; }, null, /checked out .* the run is for/],
  ["a gate workflow from elsewhere", (e) => { e.GITHUB_WORKFLOW_SHA = HEAD; }, null, /gate's own workflow file/],
]) {
  const env = produceEnv();
  if (mutateEnv) mutateEnv(env);
  const w = baseWorld();
  if (mutateWorld) mutateWorld(w);
  let got = null;
  try { await mint(w, env); } catch (err) { got = err; }
  check(got instanceof NoReuse && expect.test(got.message), `produce with ${name}: want NoReuse ${expect}, got ${got?.message ?? "a manifest"}`);
}

// The produce command never fails the gate and writes nothing when it cannot describe the run.
{
  const out = join(tmp, "nothing", "ci-evidence.json");
  const code = await main(["produce"], { ...produceEnv({ GITHUB_EVENT_NAME: "push" }), CI_EVIDENCE_OUT: out },
    process.stdout, { api: mockApi(producerWorld(baseWorld())), git: gitFor(baseWorld(), MERGE), now: () => NOW, workflowsDir });
  let exists = true;
  try { readFileSync(out); } catch { exists = false; }
  check(code === 0 && !exists, `produce on a push exited ${code} and ${exists ? "wrote" : "did not write"} a manifest`);
}

// handover: the evidence job's outputs exist only once the witness was kept,
// and only when the retained file IS the decided witness.
{
  const ok = await runWitness(freshWorld(), "go");
  check(ok.ok, `the handover checks need a consistent go witness: ${ok.error?.message}`);
  const decided = JSON.stringify(ok.witness ?? {});
  const kept = join(tmp, "handover", "go.json");
  mkdirSync(dirname(kept), { recursive: true });
  const hand = async (fileText, witnessText = decided) => {
    if (fileText === null) rmSync(kept, { force: true }); else writeFileSync(kept, fileText);
    const lines = [];
    const code = await main(["handover"], { CI_EVIDENCE_WITNESS: witnessText, CI_EVIDENCE_WITNESS_FILE: kept },
      { write: (t) => { lines.push(t); return true; } });
    return { code, text: lines.join("") };
  };
  const good = await hand(`${JSON.stringify(ok.witness ?? {}, null, 2)}\n`);
  check(good.code === 0 && good.text === `reuse=true\nwitness=${decided}\n`, `the handover of a retained, identical witness printed ${JSON.stringify(good.text)}`);
  const other = structuredClone(ok.witness ?? {});
  if (other.source) other.source.run_attempt += 1;
  for (const [name, fileText, witnessText, expect] of [
    ["a retained witness that is missing (upload failed before writing)", null, decided, /retained witness is unreadable: ENOENT/],
    ["a retained witness that is truncated", decided.slice(0, 40), decided, /retained witness is unreadable/],
    ["a retained witness that is malformed", JSON.stringify({ schema: "x" }), decided, /a witness is malformed/],
    ["a retained witness that is another decision", JSON.stringify(other), decided, /not the decided one/],
    ["a decided witness that is empty (verify output lost)", decided, "", /decided witness is not JSON/],
  ]) {
    const r = await hand(fileText, witnessText);
    check(r.code === 0 && r.text.startsWith("reuse=false\nreason=") && expect.test(r.text) && !r.text.includes("witness="),
      `the handover with ${name} printed ${JSON.stringify(r.text)} (exit ${r.code}); want reuse=false matching ${expect}`);
  }
}

// confirm: offline binding of one job's check run to the witness.
{
  const ok = await runWitness(freshWorld(), "go");
  check(ok.ok, `the confirm checks need a consistent go witness, and none was produced: ${ok.error?.message}`);
  const text = JSON.stringify(ok.witness ?? {});
  if (ok.ok) {
  const env = {
    GITHUB_EVENT_NAME: "push", GITHUB_REF: "refs/heads/main", GITHUB_SHA: MAIN, GITHUB_RUN_ID: String(CUR_RUN),
    GITHUB_RUN_ATTEMPT: "1",
    GITHUB_REPOSITORY_ID: String(REPO_ID), GITHUB_REPOSITORY: REPO, GITHUB_JOB: "race-account",
    GITHUB_WORKFLOW_REF: `${REPO}/.github/workflows/go.yml@refs/heads/main`,
  };
  let threw = null;
  try { confirm({ env, laneId: "go", witnessText: text, registry: REGISTRY }); } catch (err) { threw = err; }
  check(threw === null, `confirm refused a valid witness: ${threw?.message}`);
  for (const [name, laneId, envPatch, textPatch, expect] of [
    ["another lane", "ios", {}, null, /lane go, this is ios/],
    ["another commit", "go", { GITHUB_SHA: hex("q") }, null, /the witness is for/],
    ["another run", "go", { GITHUB_RUN_ID: "5" }, null, /from run/],
    // Finding 1: the exact attempt the evidence job decided for.
    ["a later attempt of the same run", "go", { GITHUB_RUN_ATTEMPT: "2" }, null, /decided for attempt 1, this is attempt "2"/],
    ["an attempt written as 01", "go", { GITHUB_RUN_ATTEMPT: "01" }, null, /decided for attempt 1, this is attempt "01"/],
    ["an attempt written as 1.0", "go", { GITHUB_RUN_ATTEMPT: "1.0" }, null, /this is attempt "1\.0"/],
    ["no attempt at all", "go", { GITHUB_RUN_ATTEMPT: undefined }, null, /this is attempt null/],
    ["a run id written as 1e3", "go", { GITHUB_RUN_ID: "3.69e10" }, null, /from run/],
    ["a pull request", "go", { GITHUB_EVENT_NAME: "pull_request" }, null, /not a push to main/],
    ["a job the witness does not cover", "go", { GITHUB_JOB: "evidence" }, null, /may not be witnessed/],
    ["a fresh job", "macos", { GITHUB_JOB: "signed-build", GITHUB_WORKFLOW_REF: `${REPO}/.github/workflows/macos.yml@refs/heads/main` }, null, /lane go, this is macos|may not be witnessed/],
    ["a witness short of one check", "go", {}, (w) => { w.jobs["race-account"].pop(); }, /does not vouch for every check/],
    ["a malformed witness", "go", {}, (w) => { w.extra = true; }, /witness has keys/],
    ["no witness at all", "go", {}, () => null, /not JSON|witness is not an object/],
  ]) {
    let t = text;
    if (textPatch) { const w = JSON.parse(text); const r = textPatch(w); t = r === null ? "" : JSON.stringify(w); }
    let err = null;
    try { confirm({ env: { ...env, ...envPatch }, laneId, witnessText: t, registry: REGISTRY }); } catch (e) { err = e; }
    check(err !== null && expect.test(err.message), `confirm with ${name}: want a refusal matching ${expect}, got ${err?.message ?? "acceptance"}`);
  }
  }
}

// The archive reader.
{
  const good = { name: "ci-evidence.json", data: '{"a":1}' };
  check(readSingleEntryZip(zipOf([good]), "ci-evidence.json").toString() === '{"a":1}', "a deflated entry with a data descriptor was not read");
  check(readSingleEntryZip(zipOf([{ ...good, method: 0, flags: 0 }]), "ci-evidence.json").toString() === '{"a":1}', "a stored entry was not read");
  for (const [name, bytes, expect] of [
    ["two entries", zipOf([good, { name: "b", data: "x" }]), /holds 2 entries/],
    ["another name", zipOf([{ ...good, name: "evidence.json" }]), /want "ci-evidence\.json"/],
    ["a path traversal", zipOf([{ ...good, name: "../ci-evidence.json" }]), /want "ci-evidence\.json"/],
    ["a nested path", zipOf([{ ...good, name: "x/ci-evidence.json" }]), /want "ci-evidence\.json"/],
    ["a directory", zipOf([{ ...good, ext: 0o040755 }]), /not a regular file/],
    ["a symlink", zipOf([{ ...good, ext: 0o120777 }]), /not a regular file/],
    ["encryption", zipOf([{ ...good, flags: 0x0009 }]), /flags 0x9/],
    ["an unknown method", zipOf([{ ...good, method: 12 }]), /compression method 12/],
    ["a bad CRC", zipOf([{ ...good, crc: 1234 }]), /CRC does not match/],
    ["a lying size", zipOf([{ ...good, usize: 3 }]), /inflated to 7 bytes|does not inflate/],
    ["ZIP64", zipOf([{ ...good, usize: 0xffffffff }]), /ZIP64|above the/],
    ["an oversized entry", zipOf([{ ...good, data: "x".repeat(LIMITS.manifestBytes + 1) }]), /above the \d+-byte cap/],
    ["trailing bytes", Buffer.concat([zipOf([good]), Buffer.from("junk")]), /trailing bytes|no end-of-central/],
    ["no archive at all", Buffer.from("not a zip at all, definitely not"), /no end-of-central-directory/],
    ["an empty buffer", Buffer.alloc(0), /0 bytes/],
  ]) {
    let err = null;
    try { readSingleEntryZip(bytes, "ci-evidence.json"); } catch (e) { err = e; }
    check(err instanceof NoReuse && expect.test(err.message), `the zip reader accepted ${name}, or refused it for the wrong reason: ${err?.message}`);
  }
}

// The schemas and the registry.
{
  const m = structuredClone(manifest);
  check(validateManifest(m) === m, "validateManifest refused the produced manifest");
  for (const [name, patch, expect] of [
    ["a duplicate job id", (x) => { x.jobs.push({ ...x.jobs[0], name: "dup" }); }, /job id twice/],
    ["a duplicate job name", (x) => { x.jobs.push({ ...x.jobs[0], id: 123456 }); }, /job name twice/],
    ["a numeric string id", (x) => { x.run.id = String(x.run.id); }, /manifest\.run\.id is malformed/],
    ["a short sha", (x) => { x.checkout.sha = "abc"; }, /manifest\.checkout\.sha is malformed/],
    ["a fork flag", (x) => { x.pull_request.same_repository = false; }, /manifest\.pull_request is malformed/],
    ["a non-merge ref", (x) => { x.checkout.ref = "refs/heads/main"; }, /checkout\.ref is malformed/],
    ["too many jobs", (x) => { x.jobs = Array.from({ length: LIMITS.jobs + 1 }, (_, i) => ({ ...x.jobs[0], id: i + 1, name: `j${i}` })); }, /manifest\.jobs is malformed/],
  ]) {
    const x = structuredClone(manifest);
    patch(x);
    let err = null;
    try { validateManifest(x); } catch (e) { err = e; }
    check(err instanceof NoReuse && expect.test(err.message), `validateManifest accepted ${name}: ${err?.message}`);
  }
  let witnessErr = null;
  try { validateWitness({ schema: "x" }); } catch (e) { witnessErr = e; }
  check(witnessErr instanceof NoReuse, "validateWitness accepted a non-witness");
  for (const [name, patch, expect] of [
    ["a fresh step on a macOS job", (r) => { r.lanes.ios.jobs["ios-build"].freshSteps = ["x"]; }, /keeps steps fresh on macos-15/],
    ["an unknown lane", (r) => { r.lanes.nope = r.lanes.go; }, /not a lane the merge gate calls/],
    ["a duplicated check", (r) => { r.lanes.go.jobs.test.checks.push("cli-windows"); }, /names the check "cli-windows" twice/],
    ["an unbounded freshness", (r) => { r.maxAgeHours = 1e9; }, /maxAgeHours/],
    ["another producer", (r) => { r.producer.workflow = "go.yml"; }, /producer block/],
    ["a scope gate that is not a job", (r) => { r.lanes.web.scope.gates.push("nope"); }, /malformed scope/],
  ]) {
    const r = JSON.parse(registryText);
    patch(r);
    let err = null;
    try { loadRegistry(JSON.stringify(r)); } catch (e) { err = e; }
    check(err instanceof NoReuse && expect.test(err.message), `loadRegistry accepted ${name}: ${err?.message}`);
  }
}

// Pagination: a full second page is read, a short count is refused.
{
  const items = Array.from({ length: 230 }, (_, i) => ({ id: i + 1 }));
  const api = { json: async (path) => { const q = new URL(path, "https://x/").searchParams; return { total_count: 230, list: page(items, q) }; } };
  const all = await listCounted(api, "repos/x/list", "list", 1000);
  check(all.length === 230 && all[229].id === 230, `listCounted read ${all.length} of 230 entries across three pages`);
  let err = null;
  try { await listCounted(api, "repos/x/list", "list", 100); } catch (e) { err = e; }
  check(err instanceof NoReuse && /above the cap/.test(err.message), "listCounted accepted a list above its cap");
}

// ── 4. the real CLI against a local HTTP server ─────────────────────────────

const git = (args, cwd) => {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
};

async function e2e() {
  const repo = join(tmp, "repo");
  spawnSync("mkdir", ["-p", join(repo, ".github/workflows"), join(repo, "server"), join(repo, "scripts/ci")]);
  writeFileSync(join(repo, ".github/workflows/go.yml"), readFileSync(join(workflowsDir, "go.yml")));
  writeFileSync(join(repo, "server/main.go"), "package main\n");
  writeFileSync(join(repo, "scripts/ci/ci-evidence.mjs"), "// fixture\n");
  git(["init", "-q", "-b", "main"], repo);
  git(["-c", "user.email=t@t", "-c", "user.name=t", "add", "-A"], repo);
  git(["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "fixture"], repo);
  const sha = git(["rev-parse", "HEAD"], repo);
  const tree = git(["rev-parse", "HEAD^{tree}"], repo);
  const lsTree = spawnSync("git", ["ls-tree", "-r", "-z", "--full-tree", "HEAD"], { cwd: repo }).stdout.toString("utf8");

  const world = baseWorld();
  world.gitTree = tree;
  world.mergeCommit.tree.sha = tree;
  world.lsTree = lsTree;
  world.pulls[0].merge_commit_sha = sha;
  world.pr.merge_commit_sha = sha;
  world.current.head_sha = sha;
  world.current.path = ".github/workflows/go.yml";
  const pw = producerWorld(world);
  const m = await produce({ env: produceEnv(), api: mockApi(pw), git: gitFor(pw, MERGE), registry: REGISTRY,
    now: () => new Date(Date.now() - 60_000), workflowsDir });
  world.zip = zipManifest(m);
  world.artifactPatch = { expires_at: new Date(Date.now() + 7 * 86400_000).toISOString().replace(/\.\d{3}Z$/, "Z") };
  world.now = new Date();
  world.run.updated_at = new Date(Date.now() - 30_000).toISOString().replace(/\.\d{3}Z$/, "Z");
  // Rebind the routes from the fixed MAIN to the real fixture commit.
  const api = mockApi(world);
  const seen = [];
  let corrupt = false;
  const server = createServer(async (req, res) => {
    seen.push({ url: req.url, auth: req.headers.authorization ?? null });
    try {
      if (req.url.startsWith("/blob/")) {
        const id = Number(/^\/blob\/(\d+)\.zip$/.exec(req.url)?.[1]);
        const hit = artifactTable(world).find((a) => a.id === id);
        if (!hit) { res.writeHead(404); res.end(); return; }
        res.writeHead(200, { "content-type": "application/zip" });
        res.end(corrupt && id === ART ? Buffer.concat([hit.bytes, Buffer.from("x")]) : hit.bytes);
        return;
      }
      if (req.headers.authorization !== "Bearer test-token") { res.writeHead(401); res.end("{}"); return; }
      const path = req.url.replace(/^\//, "").replace(`commits/${sha}/pulls`, `commits/${MAIN}/pulls`)
        .replace(`head_sha=${sha}`, `head_sha=${MAIN}`)
        .replace(`actions/runs/${CUR_RUN}`, `actions/runs/${CUR_RUN}`);
      const download = /^repos\/relayium\/relayium\/actions\/artifacts\/(\d+)\/zip$/.exec(path);
      if (download) {
        res.writeHead(302, { location: `http://127.0.0.1:${server.address().port}/blob/${download[1]}.zip` });
        res.end();
        return;
      }
      const body = await api.json(path);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    } catch (err) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ message: err.message }));
    }
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const env = {
    PATH: process.env.PATH, HOME: process.env.HOME,
    ...pushEnv("go", { GITHUB_SHA: sha, GITHUB_EVENT_PATH: writeJson("push-e2e.json", { ref: "refs/heads/main", after: sha, created: false, deleted: false, forced: false, repository: { id: REPO_ID } }) }),
    GITHUB_API_URL: `http://127.0.0.1:${server.address().port}`, GH_TOKEN: "test-token",
    GITHUB_STEP_SUMMARY: join(tmp, "summary.md"), CI_EVIDENCE_WITNESS_FILE: join(tmp, "witness", "go.json"),
    CI_EVIDENCE_CURRENT_TOOLCHAIN_DIR: join(tmp, "current-toolchain"),
  };
  // What the go lane's evidence job would have written after its own probe (unit fixtures).
  mkdirSync(env.CI_EVIDENCE_CURRENT_TOOLCHAIN_DIR, { recursive: true });
  for (const [name, cert] of currentCerts({ ...world, now: new Date(), currentPatch2: {} }, "go", env)) {
    writeFileSync(join(env.CI_EVIDENCE_CURRENT_TOOLCHAIN_DIR, `${name}.json`), JSON.stringify(cert));
  }
  // A child process, asynchronously: the server answering it runs on this event loop.
  const run = (args, extra = {}) => new Promise((done) => {
    import("node:child_process").then(({ spawn }) => {
      const child = spawn(process.execPath, [resolve(repoRoot, "scripts/ci/ci-evidence.mjs"), ...args],
        { cwd: repo, env: { ...env, ...extra } });
      let stdout = ""; let stderr = "";
      child.stdout.on("data", (d) => { stdout += d; });
      child.stderr.on("data", (d) => { stderr += d; });
      child.on("close", (status) => done({ status, stdout, stderr }));
    });
  });

  const okRun = await run(["witness", "go"]);
  const lines = okRun.stdout.trim().split("\n");
  check(okRun.status === 0 && lines[0] === "reuse=true" && lines[1] === "reason=verified" && lines[2]?.startsWith("witness={"),
    `the CLI did not print reuse=true for a consistent world over HTTP (exit ${okRun.status}):\n${okRun.stdout}\n${okRun.stderr}`);
  const blob = seen.filter((s) => s.url.startsWith("/blob/"));
  // The proof plus one certificate per go check (every matrix entry), each fetched once, none with the token.
  const goChecks = Object.values(REGISTRY.lanes.go.jobs).reduce((n, j) => n + j.checks.length, 0);
  check(blob.length === 1 + goChecks && blob.every((b) => b.auth === null),
    `the artifact redirect hops carried the token, or not every certificate was fetched once: ${blob.length} hops, want ${1 + goChecks}`);
  check(seen.some((s) => /attempts\/1\/jobs\?per_page=100&page=1/.test(s.url)), "the CLI did not page the job inventory");
  let witnessFile = null;
  try { witnessFile = JSON.parse(readFileSync(env.CI_EVIDENCE_WITNESS_FILE, "utf8")); } catch { /* checked below */ }
  check(witnessFile?.lane === "go" && witnessFile?.target?.sha === sha, "the CLI did not keep the witness file for upload");

  if (lines[2]?.startsWith("witness=")) {
    const confirmed = await run(["confirm", "go"], { GITHUB_JOB: "race-account", CI_EVIDENCE_WITNESS: lines[2].slice(8) });
    check(confirmed.status === 0, `confirm refused the CLI's own witness: ${confirmed.stderr}`);
    const wrong = await run(["confirm", "ios"], { GITHUB_JOB: "ios-build", CI_EVIDENCE_WITNESS: lines[2].slice(8) });
    check(wrong.status === 1 && /::error::/.test(wrong.stderr), `confirm accepted another lane's witness (exit ${wrong.status})`);
    // Finding 1 through the shipped CLI: "re-run failed jobs" reaches attempt 2
    // with attempt 1's evidence outputs; the witness step must fail, not pass.
    const rerun = await run(["confirm", "go"], { GITHUB_JOB: "race-account", GITHUB_RUN_ATTEMPT: "2", CI_EVIDENCE_WITNESS: lines[2].slice(8) });
    check(rerun.status === 1 && /decided for attempt 1, this is attempt "2"/.test(rerun.stderr),
      `confirm accepted attempt 1's witness in attempt 2 (exit ${rerun.status}): ${rerun.stderr}`);
  }

  corrupt = true;
  const bad = await run(["witness", "go"]);
  check(bad.status === 0 && bad.stdout.startsWith("reuse=false\nreason=") && /API digest/.test(bad.stdout),
    `a corrupted artifact over HTTP did not become reuse=false with its reason (exit ${bad.status}): ${bad.stdout}`);
  corrupt = false;
  const noToken = await run(["witness", "go"], { GH_TOKEN: "" });
  check(noToken.status === 0 && /^reuse=false\nreason=no API token/.test(noToken.stdout), `a missing token did not fail closed: ${noToken.stdout}`);
  const pr = await run(["witness", "go"], { GITHUB_EVENT_NAME: "pull_request" });
  check(pr.status === 0 && pr.stdout.startsWith("reuse=false"), "a pull_request run did not fail closed through the CLI");
  const usage = await run(["witness"]);
  check(usage.status === 2, `a malformed command exited ${usage.status}, want 2`);
  server.close();
}

try {
  await e2e();
} catch (err) {
  check(false, `the HTTP end-to-end run threw: ${err.stack}`);
}

// The real API client: bounded retries on transient failures only, never on a 4xx.
{
  const respond = (statuses) => {
    let n = 0;
    return { calls: () => n, fetchImpl: async () => {
      const status = statuses[Math.min(n, statuses.length - 1)];
      n += 1;
      return new Response(JSON.stringify({ ok: status }), { status, headers: { "content-type": "application/json" } });
    } };
  };
  const flaky = respond([502, 200]);
  const body = await gitHubApi({ token: "t", fetchImpl: flaky.fetchImpl, sleep: async () => {} }).json("repos/x");
  check(body.ok === 200 && flaky.calls() === 2, "gitHubApi did not retry a single 502");
  for (const [statuses, calls, expect] of [[[502], 3, /failed after retries \(HTTP 502\)/], [[404], 1, /returned HTTP 404/], [[403], 1, /returned HTTP 403/]]) {
    const r = respond(statuses);
    let err = null;
    try { await gitHubApi({ token: "t", fetchImpl: r.fetchImpl, sleep: async () => {} }).json("repos/x"); } catch (e) { err = e; }
    check(err instanceof NoReuse && expect.test(err.message) && r.calls() === calls,
      `gitHubApi on ${statuses}: want ${calls} call(s) and ${expect}, got ${r.calls()} and ${err?.message}`);
  }
}

// The real API client refuses plain http to anything but loopback.
{
  let err = null;
  try { gitHubApi({ token: "t", baseUrl: "http://api.example.com" }); } catch (e) { err = e; }
  check(err instanceof NoReuse && /not https/.test(err.message), "gitHubApi accepted a plain-http API base");
}

// ── 5. the guards that judge lanes through the full-path projection ─────────
//
// Six policy tests written about the lanes' ORIGINAL steps read each workflow
// through `fullPathOf` (scripts/ci/ci-evidence-view.mjs), which strips exactly
// the canonical evidence adoption. That is only safe if the projection hides
// nothing else: so each guard runs against a scratch copy of this repository
// (`.github/`, `scripts/` and the CLI test sources copied, everything else
// linked), first unmutated — it must pass — and then with a full-path break
// DISGUISED as adoption, which it must still report by its own words. The
// Swift half (MacSurfaceGuardTests) is checked in the Swift package's suite.
//
// Skipped only when CI_EVIDENCE_TEST_SCOPE=verifier: the merge gate's aggregate
// runs the verifier half right before it mints a proof, and repo-hygiene runs
// this whole file on every pull request and every main push.
export const PROJECTION_CONTROLS = [
  ["contract-ci-policy", "contracts.yml", "a contract step guarded by a non-canonical `reuse != 'true' || always()`",
    (t) => t.replace("        if: needs.evidence.outputs.reuse != 'true'\n        working-directory: server",
      "        if: needs.evidence.outputs.reuse != 'true' || always()\n        working-directory: server"),
    // Not canonical ⇒ the file is not projected, and the guard fails on the raw adoption itself.
    /contracts\.yml(\/go-contract: a step sets "if:"|'s path filter is \[)/],
  ["swift-ci-boundary", "swift-package.yml", "the package suite guarded by a non-canonical condition",
    (t) => { const i = t.indexOf("      - name: swift test"); const j = t.indexOf("if: needs.evidence.outputs.reuse != 'true'", i);
      return j < 0 ? t : `${t.slice(0, j)}if: needs.evidence.outputs.reuse != 'true' || always()${t.slice(j + 42)}`; },
    /swift-package\.yml(\/swift-test: a step sets "if:"|'s path filter is \[)/],
  ["web-lane-scope", "web.yml", "a Go-running Web job made to wait on scope beside the evidence edge",
    (t) => { const i = t.indexOf("  sealed-box-interop:"); return t.slice(0, i) + t.slice(i).replace("    needs: evidence\n    if: ${{ !cancelled() }}", "    needs: [scope, evidence]\n    if: ${{ !cancelled() && needs.scope.result == 'success' }}"); },
    /web\.yml\/sealed-box-interop: `needs: scope` ties a Go-running job to the scope job/],
  ["ui-test-budget", "ios.yml", "the iPhone UI diagnosis narrowed to failure() inside an evidence guard",
    (t) => t.replace(/if: always\(\) && needs\.evidence\.outputs\.reuse != 'true' && \(contains\(fromJSON\('\["failure","cancelled"\]'\), steps\.ui_smoke\.outcome\)[^\n]*\)/,
      "if: needs.evidence.outputs.reuse != 'true' && (failure())"),
    /"Retain UI smoke diagnosis" runs `if: (failure\(\)|needs\.evidence\.outputs\.reuse != 'true' && \(failure\(\)\))`/],
  ["native-web-pairing-gate", "native-web-pairing.yml", "the macOS pairing job whose runner ternary falls back to Ubuntu",
    (t) => t.replace("|| 'macos-15' }}", "|| 'ubuntu-latest' }}"),
    /the pairing job runs on "\$\{\{"/],
  ["cli-interop-matrix", "native-web-pairing.yml", "the CLI ↔ browser job made advisory next to its evidence edge",
    (t) => { const i = t.indexOf("  cli-web:"); return t.slice(0, i) + t.slice(i).replace("    needs: evidence\n", "    needs: evidence\n    continue-on-error: true\n"); },
    /the A12 wiring is incomplete/],
];

function projectionFarm() {
  const dir = mkdtempSync(join(tmpdir(), "ci-evidence-farm-"));
  for (const entry of readdirSync(repoRoot)) {
    if (entry === ".git") continue;
    if (entry === ".github" || entry === "scripts") { cpSync(join(repoRoot, entry), join(dir, entry), { recursive: true }); continue; }
    if (entry === "server") {
      mkdirSync(join(dir, "server/cmd"), { recursive: true });
      for (const s of readdirSync(join(repoRoot, "server"))) if (s !== "cmd") symlinkSync(join(repoRoot, "server", s), join(dir, "server", s));
      for (const c of readdirSync(join(repoRoot, "server/cmd"))) {
        if (c === "relayium") cpSync(join(repoRoot, "server/cmd/relayium"), join(dir, "server/cmd/relayium"), { recursive: true });
        else symlinkSync(join(repoRoot, "server/cmd", c), join(dir, "server/cmd", c));
      }
      continue;
    }
    symlinkSync(join(repoRoot, entry), join(dir, entry));
  }
  for (const args of [["init", "-q"], ["add", "-A"], ["commit", "-q", "-m", "farm"]]) {
    const r = spawnSync("git", ["-C", dir, "-c", "user.email=t@t", "-c", "user.name=t", ...args], { encoding: "utf8" });
    if (r.status !== 0) throw new Error(`git ${args[0]} in the scratch copy: ${r.stderr}`);
  }
  return dir;
}

if (process.env.CI_EVIDENCE_TEST_SCOPE !== "verifier") {
  let farmDir = null;
  try {
    farmDir = projectionFarm();
    const runGuard = (guard) => spawnSync(process.execPath, [join(farmDir, `scripts/test/${guard}-test.mjs`)], { encoding: "utf8" });
    for (const [guard, file, what, mutate, expect] of PROJECTION_CONTROLS) {
      const base = runGuard(guard);
      check(base.status === 0, `${guard} fails on the unmutated scratch copy, so its projection control proves nothing:\n${(base.stdout + base.stderr).slice(-600)}`);
      const path = join(farmDir, ".github/workflows", file);
      const original = readFileSync(path, "utf8");
      const broken = mutate(original);
      check(broken !== original, `${guard}: the control "${what}" no longer applies to ${file} (stale anchor)`);
      if (broken === original) continue;
      writeFileSync(path, broken);
      const r = runGuard(guard);
      writeFileSync(path, original);
      check(r.status !== 0 && expect.test(r.stdout + r.stderr), `${guard} did not report "${what}" through the full-path `
        + `projection (exit ${r.status}); want ${expect}. A projection that hides a real break is a waiver, not a view.`);
    }
  } catch (err) {
    check(false, `the projection controls could not run: ${err.stack}`);
  } finally {
    if (farmDir) rmSync(farmDir, { recursive: true, force: true });
  }
}

rmSync(tmp, { recursive: true, force: true });

if (failures.length > 0) {
  console.error(`ci-evidence-test: ${failures.length} of ${checks} checks failed\n`);
  for (const f of failures) console.error(`  ✗ ${f}\n`);
  process.exit(1);
}
console.log(`ci-evidence-test: OK (${checks} checks: `
  + `${LANE_IDS.length - UNCERTIFIABLE_LANES.length} lanes reuse, ${UNCERTIFIABLE_LANES.length} uncertifiable refused; ${NEGATIVES.length} single-fact breaks refused; produce/confirm/zip/schema/registry refusals; depth-1 real-git ancestry; HTTP CLI end to end; `
  + `${process.env.CI_EVIDENCE_TEST_SCOPE === "verifier" ? "guard projection controls skipped (verifier scope)" : `${PROJECTION_CONTROLS.length} guard projection controls`})`);
