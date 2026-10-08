// scripts/test/macos-evidence-cases.mjs — executable controls for the macOS
// release's evidence judge, its package verifier, its release contract, the
// PR-free delivery body and merge-gate's strict frozen mode.
//
// Run by `scripts/test/macos-publish-order-test.mjs` (which `repo-hygiene.yml`
// already runs on every pull request), so these controls execute in CI without
// a new workflow step: `export async function run()` returns the failures.
// Standalone: `node scripts/test/macos-evidence-cases.mjs`.
//
// Every case is a NEGATIVE control unless it says otherwise: a world that is
// valid except for one defect, and the assertion that the judge refuses it for
// that reason. The valid world runs first in each family, so a judge that
// refused everything would fail the positive case rather than pass the rest.
//
// Nothing here touches GitHub. The API is either an in-process fake or a local
// HTTP server the real helper is pointed at through GITHUB_API_URL; gh, git,
// codesign, hdiutil, lipo, plutil and xcodebuild are PATH stubs.

import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync,
  symlinkSync, writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { deflateRawSync } from "node:zlib";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import {
  CANDIDATE_REF,
  PROVENANCE_SCHEMA,
  CANONICAL_CERTIFY_JOB,
  CANONICAL_EVIDENCE_JOB,
  CANONICAL_JOB_CONDITIONS,
  CANONICAL_SCREEN_JOB,
  CANONICAL_WITNESS_STEPS,
  LEGACY_ADOPTED_UI_SMOKE_CONDITIONS,
  WITNESSED_CONTRACT_EVIDENCE_JOB,
  WITNESSED_CONTRACT_JOB,
  CANONICAL_CONTRACT_JOB,
  EVENT_CONTRACT_JOB,
  EVENT_CONTRACT_CONDITIONS,
  EVENT_CONTRACT_BRANCH,
  RELEASE_INTENT_BRANCH,
  ADOPTED_SHAPE,
  EVENT_CONTRACT_SHAPE,
  WITNESSED_CONTRACT_SHAPE,
  evidenceIdentity,
  Refused,
  Unavailable,
  crc32,
  workflowShape,
  decide,
  hashPayload,
  installPayload,
  readPayloadArchive,
  findGateRun,
  judgeFrozenCandidate,
  judgeGateRun,
  publishPreflight,
  readback,
  COVERAGE_CERTIFIED,
  CertifiedUnavailable,
  COVERAGE_EXECUTED,
  coverageOf,
  judgeCertifiedCoverage,
  judgeProducerRoster,
  pinnedSourceTree,
  judgeWitnessed,
  judgeWitnessTiming,
  CERTIFY_TO_VERIFIED_MAX_MS,
  frozenCertificates,
  validateCoverage,
  verifyHistoricalCertifiedCoverage,
} from "../release/macos-evidence.mjs";
import { CANDIDATE_PATHS } from "../../web/scripts/macos-release-candidate.mjs";
import { certifiedWorld as createCertifiedGitWorld, isolatedGitEnvironment } from './fixtures/macos-certified/world.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const REPO = "relayium/relayium";
const REPO_ID = 1282331342;
const SHA = "a".repeat(40);
const NOW = Date.parse("2026-10-01T18:00:00Z");
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const clone = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));

// ── fixtures ────────────────────────────────────────────────────────────────

function payload({ dmg = "signed dmg bytes", tool = "generate_appcast bytes", provenance = {}, extra = null } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "macos-evidence-payload-"));
  mkdirSync(join(dir, "release-tools"));
  writeFileSync(join(dir, "Relayium.dmg"), dmg);
  writeFileSync(join(dir, "release-tools/generate_appcast"), tool);
  const dmgHash = sha256(Buffer.from(dmg));
  writeFileSync(join(dir, "Relayium.dmg.sha256"), `${dmgHash}  Relayium.dmg\n`);
  const base = {
    schema: PROVENANCE_SCHEMA,
    repository: REPO,
    repositoryId: String(REPO_ID),
    sha: SHA,
    ref: "refs/heads/main",
    event: "push",
    runId: "500",
    runAttempt: "1",
    workflowRef: `${REPO}/.github/workflows/macos.yml@refs/heads/main`,
    workflowSha: SHA,
    releaseVersion: "",
    channel: "direct",
    arch: "arm64",
    teamId: "7PVYUG4YQS",
    version: "1.4.5",
    build: "42",
    shareExtensionVersion: "1.4.5",
    shareExtensionBuild: "42",
    toolchain: { xcode: "Xcode 16.4 Build version 16F6", swift: "swift 6.1", macos: "15.6 (24G84)", runnerImage: "macos15/20260921" },
    signedBuildSource: "built",
    signedDmgSha256: dmgHash,
    dmgSha256: dmgHash,
    generateAppcastSha256: sha256(Buffer.from(tool)),
  };
  const merged = typeof provenance === "function" ? provenance(base) : { ...base, ...provenance };
  writeFileSync(join(dir, "provenance.json"), typeof merged === "string" ? merged : JSON.stringify(merged));
  const files = ["Relayium.dmg", "Relayium.dmg.sha256", "provenance.json", "release-tools/generate_appcast"];
  if (extra) {
    writeFileSync(join(dir, extra), "extra");
    files.push(extra);
  }
  const zip = join(dir, "out.zip");
  const made = spawnSync("zip", ["-q", "-X", zip, ...files], { cwd: dir });
  if (made.status !== 0) throw new Error(`zip failed: ${made.stderr}`);
  const bytes = readFileSync(zip);
  rmSync(dir, { recursive: true, force: true });
  return bytes;
}

const JOBS = [
  "contract",
  "test",
  "ui-smoke (app-shell, RelayiumUITests/AppShellUITests, 30)",
  "ui-smoke (device-inbox, RelayiumUITests/DeviceInboxUITests,RelayiumUITests/SubscriptionUITests,Re...",
  "signed-build",
];

/**
 * The step records the jobs API reported for each job of a real `main` push
 * run of the legacy (five-job) `macos.yml` — run 36883327742, attempt 1 —
 * in order, names verbatim. A fixture job carries these as executed steps.
 */
const CHECKOUT_STEP = "Run actions/checkout@de0fac2e4500dabe0009e67214ff5f5447ce83dd";
const REAL_STEPS = {
  contract: ["Set up job", CHECKOUT_STEP, "Validate release contract", `Post ${CHECKOUT_STEP}`, "Complete job"],
  test: ["Set up job", CHECKOUT_STEP, "Toolchain versions", "Release script tests", `Post ${CHECKOUT_STEP}`, "Complete job"],
  "ui-smoke/app-shell": ["Set up job", CHECKOUT_STEP, "Import UI signing certificate", "Install UI provisioning profiles",
    "Run macOS product-flow UI smoke (app-shell)", "Upload macOS UI smoke result evidence", "Remove UI signing keychain",
    `Post ${CHECKOUT_STEP}`, "Complete job"],
  "ui-smoke/device-inbox": ["Set up job", CHECKOUT_STEP, "Import UI signing certificate", "Install UI provisioning profiles",
    "Run macOS product-flow UI smoke (device-inbox)", "Upload macOS UI smoke result evidence", "Remove UI signing keychain",
    `Post ${CHECKOUT_STEP}`, "Complete job"],
  "signed-build": ["Set up job", CHECKOUT_STEP, "Import signing certificate", "Install provisioning profile",
    "Install Share extension provisioning profile", "Build (Mac App Store target, unsigned)",
    "Verify the App Store product embeds no updater", "Verify the App Store product ships both privacy manifests",
    "Build (signed, Release)", "Re-sign Sparkle distribution components", "Verify signature and entitlements",
    "Verify the direct product ships both privacy manifests", "Package and verify DMG", "Record signed package provenance",
    "Upload signed package artifact", "Remove signing keychain", `Post ${CHECKOUT_STEP}`, "Complete job"],
  // The canonical adoption's evidence job on an ordinary main push whose PR
  // proof did NOT cover the tree: the decision ran, nothing was kept, nothing
  // was handed over. (The frozen previous adoption also ran its Ubuntu probe:
  // EVIDENCE_UBUNTU_PROBE, inserted by reuseWorld.)
  evidence: ["Set up job", "Check out the verifier (ordinary main push only)",
    "Node for the verifier (ordinary main push only)",
    "Take the certify jobs' certificates (ordinary main push only)",
    "Does the merged pull request's full proof cover this main tree?",
    ["Keep the witness (reuse only)", "skipped"],
    ["Hand the decision to the lane only once its witness is kept", "skipped"],
    "Post Check out the verifier (ordinary main push only)", "Complete job"],
  // The screen on a main push with no usable proof: it ran and said no.
  screen: ["Set up job", "Check out the verifier", "Node for the verifier",
    "Could a current toolchain certificate complete a proof?", "Post Check out the verifier", "Complete job"],
};
/** The full path's own toolchain capture, after every original step (adoption only). */
const CAPTURE_STEPS = ["Certify this job's toolchain", "Keep this job's toolchain certificate"];
/** The evidence job's Ubuntu probe: only the frozen previous adoption had it (for `contract`). */
const EVIDENCE_UBUNTU_PROBE = "Certify this runner's toolchain now (ordinary main push only)";
const JOB_IDS = ["contract", "test", "ui-smoke/app-shell", "ui-smoke/device-inbox", "signed-build"];
const LABELS = { contract: ["ubuntu-latest"], evidence: ["ubuntu-latest"], screen: ["ubuntu-latest"] };
const steps = (list) => list.map((entry, index) => {
  const [name, conclusion] = Array.isArray(entry) ? entry : [entry, "success"];
  // Authentic step records carry their own times (null when never started).
  const ran = conclusion !== "skipped";
  return {
    name, status: "completed", conclusion, number: index + 1,
    started_at: ran ? "2026-10-01T15:06:00Z" : null, completed_at: ran ? "2026-10-01T15:06:00Z" : null,
  };
});
const WITNESS = [
  "Check out the verifier (witness path only)",
  "Node for the verifier (witness path only)",
  "Witness — the pull request's full proof covers this job",
];

/**
 * The PR→main adoption generator, when this tree has it (or the tree named by
 * MACOS_EVIDENCE_VIEW_ROOT). Its full-path text is the ONLY way to read the
 * lane's original definition out of an adopted `macos.yml`: an adopted file
 * cannot be adopted twice (the generator refuses), so every control below
 * starts from `fullPathText`, never from the live adopted text.
 */
const VIEW_ROOT = process.env.MACOS_EVIDENCE_VIEW_ROOT ?? repoRoot;
const VIEW = await (async () => {
  const viewPath = join(VIEW_ROOT, "scripts/ci/ci-evidence-view.mjs");
  try { lstatSync(viewPath); } catch { return null; }
  const view = await import(viewPath);
  return { view, ...view.registries(VIEW_ROOT) };
})();
const LIVE_WORKFLOW = readFileSync(join(repoRoot, ".github/workflows/macos.yml"), "utf8");
/** This tree's `macos.yml` as its full path — the legacy, unadopted definition. */
const LEGACY_WORKFLOW = VIEW
  ? VIEW.view.fullPathText(LIVE_WORKFLOW, "macos", VIEW.registry.lanes.macos, VIEW.tool)
  : LIVE_WORKFLOW;

/**
 * The canonical adoption of a legacy text, structurally and from this file's
 * OWN pins: the screen, certify-macos and evidence jobs inserted first under
 * `jobs:`, each original job's needs/if/runs-on replaced by the pinned ones,
 * and the three witness steps opening the test and ui-smoke steps (the
 * contract is always fresh). With `witnessedContract`, the frozen PREVIOUS
 * adoption instead: its evidence job (with the Ubuntu probe) and the witness
 * steps opening the contract too. Prose comments and the full path's capture
 * steps are not reproduced; the judge ignores both by design. The controls
 * below also judge the generator's own output when it is present.
 */
function adoptedText(legacy = LEGACY_WORKFLOW, { witnessedContract = false } = {}) {
  const lines = legacy.split("\n");
  const out = [];
  let job = null;
  const witnessed = witnessedContract ? ["contract", "test", "ui-smoke"] : ["test", "ui-smoke"];
  for (const line of lines) {
    const key = /^ {2}([a-z0-9-]+):\s*$/.exec(line);
    if (key) job = key[1];
    if (CANONICAL_JOB_CONDITIONS[job] && /^ {4}(needs|if|runs-on):/.test(line)) continue;
    out.push(line);
    if (line === "jobs:") {
      out.push(...CANONICAL_SCREEN_JOB, ...CANONICAL_CERTIFY_JOB,
        ...(witnessedContract ? WITNESSED_CONTRACT_EVIDENCE_JOB : CANONICAL_EVIDENCE_JOB));
    }
    if (key && CANONICAL_JOB_CONDITIONS[job]) out.push(...CANONICAL_JOB_CONDITIONS[job]);
    if (line === "    steps:" && witnessed.includes(job)) out.push(...CANONICAL_WITNESS_STEPS);
  }
  return out.join("\n");
}
/** The contract's event-reading runner line and release branch, each WHOLE,
 *  in place of the current release-intent ones. A stale anchor THROWS. */
const CONTRACT_RUNS_ON = { intent: CANONICAL_JOB_CONDITIONS.contract[2], event: EVENT_CONTRACT_CONDITIONS[2] };
const CONTRACT_BRANCH = { intent: RELEASE_INTENT_BRANCH.join("\n"), event: EVENT_CONTRACT_BRANCH.join("\n") };
const withEventRunsOn = (text) => replaceOnce(text, `${CONTRACT_RUNS_ON.intent}\n`, `${CONTRACT_RUNS_ON.event}\n`);
const withEventBranch = (text) => replaceOnce(text, `${CONTRACT_BRANCH.intent}\n`, `${CONTRACT_BRANCH.event}\n`);
const withIntentRunsOn = (text) => replaceOnce(text, `${CONTRACT_RUNS_ON.event}\n`, `${CONTRACT_RUNS_ON.intent}\n`);
const withIntentBranch = (text) => replaceOnce(text, `${CONTRACT_BRANCH.event}\n`, `${CONTRACT_BRANCH.intent}\n`);
/** The frozen previous adoption: contract always fresh, runner AND branch read the caller's event. */
const eventContractText = () => withEventBranch(withEventRunsOn(adoptedText()));
/** `text` with job `id`'s whole block (its key up to the next job key) replaced by `lines`; a missing job THROWS. */
function withJob(text, id, lines) {
  const all = text.split("\n");
  const at = all.indexOf(`  ${id}:`);
  if (at < 0) throw new Error(`stale anchor: no job ${id}`);
  let end = at + 1;
  while (end < all.length && !/^ {2}[a-z0-9-]+:\s*$/.test(all[end])) end += 1;
  all.splice(at, end - at, ...lines, "");
  return all.join("\n");
}
/** The frozen adoption before that: contract witnessed and certified on Ubuntu — its WHOLE historical contract job. */
const witnessedContractText = () => withJob(adoptedText(LEGACY_WORKFLOW, { witnessedContract: true }), "contract", WITNESSED_CONTRACT_JOB);

/**
 * `text` with exactly one occurrence of `from` replaced. A missing or repeated
 * anchor THROWS: a mutation whose anchor went stale must not pass as a no-op.
 */
function replaceOnce(text, from, to) {
  const n = text.split(from).length - 1;
  if (n !== 1) throw new Error(`stale anchor: ${JSON.stringify(from.slice(0, 80))} occurs ${n} time(s)`);
  return text.replace(from, to);
}
/** `text` with `lines` inserted directly after job `id`'s `steps:`; a missing job THROWS. */
function withAfterSteps(text, id, lines) {
  const all = text.split("\n");
  const at = all.indexOf(`  ${id}:`);
  const steps = at < 0 ? -1 : all.indexOf("    steps:", at);
  if (steps < 0) throw new Error(`stale anchor: no job ${id} with steps`);
  all.splice(steps + 1, 0, ...lines);
  return all.join("\n");
}
/** `text` with job `id`'s witness prefix removed; a job without exactly that prefix THROWS. */
function withoutWitness(text, id) {
  const all = text.split("\n");
  const at = all.indexOf(`  ${id}:`);
  const steps = at < 0 ? -1 : all.indexOf("    steps:", at);
  if (steps < 0 || JSON.stringify(all.slice(steps + 1, steps + 1 + CANONICAL_WITNESS_STEPS.length)) !== JSON.stringify(CANONICAL_WITNESS_STEPS)) {
    throw new Error(`stale anchor: job ${id} has no witness prefix`);
  }
  all.splice(steps + 1, CANONICAL_WITNESS_STEPS.length);
  return all.join("\n");
}
/** The adopted ui-smoke condition triple as one text block (current or frozen legacy). */
const UI_SMOKE_TRIPLE = (lines) => `  ui-smoke:\n${lines.join("\n")}\n`;
/** The frozen previous adoption whose ui-smoke still carries the even older triple. */
const legacyUiSmokeText = () => replaceOnce(witnessedContractText(), UI_SMOKE_TRIPLE(CANONICAL_JOB_CONDITIONS["ui-smoke"]),
  UI_SMOKE_TRIPLE(LEGACY_ADOPTED_UI_SMOKE_CONDITIONS));

/**
 * A complete, valid reuse world. Every case mutates one thing. `adopted` is the
 * current adoption (contract fresh); `witnessedContract` the frozen previous one.
 */
function reuseWorld({ adopted = false, witnessedContract = false, eventContract = false } = {}) {
  if (witnessedContract || eventContract) adopted = true;
  const witnessedIds = witnessedContract ? JOB_IDS.filter((id) => id !== "signed-build")
    : JOB_IDS.filter((id) => id !== "signed-build" && id !== "contract");
  const run = {
    id: 500,
    run_attempt: 1,
    head_sha: SHA,
    head_branch: "main",
    event: "push",
    path: ".github/workflows/macos.yml",
    workflow_id: 321216057,
    status: "completed",
    conclusion: "success",
    created_at: "2026-10-01T15:00:00Z",
    run_started_at: "2026-10-01T15:00:00Z",
    repository: { id: REPO_ID, full_name: REPO, fork: false },
    head_repository: { id: REPO_ID, full_name: REPO, fork: false },
  };
  const jobs = JOBS.map((name, index) => ({
    id: 900 + index,
    name,
    run_id: 500,
    head_sha: SHA,
    run_attempt: 1,
    status: "completed",
    conclusion: "success",
    started_at: "2026-10-01T15:05:00Z",
    completed_at: "2026-10-01T15:20:00Z",
    labels: LABELS[JOB_IDS[index]] ?? ["macos-15"],
    // Under the adoption, the witness prefix is reported skipped and the
    // full path's toolchain capture runs after the original steps.
    steps: steps(adopted && witnessedIds.includes(JOB_IDS[index])
      ? [...WITNESS.map((n) => [n, "skipped"]), ...REAL_STEPS[JOB_IDS[index]].slice(0, -2),
        ...CAPTURE_STEPS, ...REAL_STEPS[JOB_IDS[index]].slice(-2)]
      : REAL_STEPS[JOB_IDS[index]]),
  }));
  if (adopted) {
    const aux = (id, name, conclusion, labels, list) => ({
      id, name, run_id: 500, head_sha: SHA, run_attempt: 1, status: "completed",
      conclusion, started_at: "2026-10-01T15:01:00Z", completed_at: "2026-10-01T15:02:00Z",
      labels, steps: steps(list),
    });
    // The common shape of a main push the merged pull request did not prove:
    // the screen said no, so the paid probe never started.
    jobs.push(aux(897, "screen", "success", ["ubuntu-latest"], REAL_STEPS.screen));
    jobs.push(aux(898, "certify-macos", "skipped", [], []));
    const evidenceSteps = [...REAL_STEPS.evidence];
    if (witnessedContract) evidenceSteps.splice(evidenceSteps.indexOf("Take the certify jobs' certificates (ordinary main push only)"), 0, EVIDENCE_UBUNTU_PROBE);
    jobs.push(aux(899, "evidence", "success", ["ubuntu-latest"], evidenceSteps));
  }
  const zip = payload();
  const artifact = {
    id: 7001,
    name: `relayium-macos-signed-${SHA}-ci`,
    expired: false,
    digest: `sha256:${sha256(zip)}`,
    size_in_bytes: zip.length,
    created_at: "2026-10-01T15:19:00Z",
    expires_at: "2026-10-15T15:19:00Z",
    workflow_run: { id: 500, repository_id: REPO_ID, head_repository_id: REPO_ID, head_branch: "main", head_sha: SHA },
  };
  return {
    workflow: { id: 321216057, path: ".github/workflows/macos.yml", state: "active" },
    runs: [run],
    run,
    attempt: { ...run },
    jobs,
    artifacts: [artifact],
    zip,
    runsTotal: null,
    workflowText: witnessedContract ? witnessedContractText() : eventContract ? eventContractText() : adopted ? adoptedText() : LEGACY_WORKFLOW,
  };
}

function apiFor(w) {
  const calls = [];
  const lists = (path) => {
    if (path.startsWith(`/repos/${REPO}/actions/workflows/${w.workflow.id}/runs?`)) {
      return { key: "workflow_runs", items: w.runs, total: w.runsTotal ?? w.runs.length };
    }
    if (path === `/repos/${REPO}/actions/runs/${w.run.id}/attempts/${w.run.run_attempt}/jobs`) {
      return { key: "jobs", items: w.jobs, total: w.jobs.length };
    }
    // Earlier attempts, when a world records them: { [n]: { attempt, jobs } }.
    for (const [n, h] of Object.entries(w.history ?? {})) {
      if (path === `/repos/${REPO}/actions/runs/${w.run.id}/attempts/${n}/jobs`) return { key: "jobs", items: h.jobs, total: h.jobs.length };
    }
    if (path === `/repos/${REPO}/actions/runs/${w.run.id}/artifacts`) {
      return { key: "artifacts", items: w.artifacts, total: w.artifacts.length };
    }
    return null;
  };
  const one = (path) => {
    if (path === `/repos/${REPO}/contents/.github/workflows/macos.yml?ref=${SHA}`) {
      return {
        path: ".github/workflows/macos.yml", encoding: "base64", sha: sha256(Buffer.from(w.workflowText)).slice(0, 40),
        content: Buffer.from(w.workflowText).toString("base64"),
      };
    }
    if (path === `/repos/${REPO}/actions/workflows/macos.yml`) return w.workflow;
    if (path === `/repos/${REPO}/actions/runs/${w.run.id}`) return w.run;
    if (path === `/repos/${REPO}/actions/runs/${w.run.id}/attempts/${w.run.run_attempt}`) return w.attempt;
    for (const [n, h] of Object.entries(w.history ?? {})) {
      if (path === `/repos/${REPO}/actions/runs/${w.run.id}/attempts/${n}`) return h.attempt;
    }
    return undefined;
  };
  const api = {
    calls,
    async get(path) {
      calls.push(path);
      const paged = /^(.*?)[?&]per_page=100&page=(\d+)$/.exec(path);
      if (paged) {
        const list = lists(paged[1]);
        if (list) {
          const page = Number(paged[2]);
          return { total_count: list.total, [list.key]: clone(list.items.slice((page - 1) * 100, page * 100)) };
        }
      }
      const body = one(path);
      if (body === undefined) {
        const error = new Error(`unrouted GET ${path}`);
        error.status = 404;
        throw error;
      }
      return clone(body);
    },
    async download(path) {
      calls.push(`DOWNLOAD ${path}`);
      const artifact = w.artifacts.find((a) => path === `/repos/${REPO}/actions/artifacts/${a.id}/zip`);
      if (!artifact || w.downloadStatus) {
        const error = new Error(`download ${path}`);
        error.status = w.downloadStatus ?? 404;
        throw error;
      }
      return w.zip;
    },
  };
  return api;
}

// ── a tiny harness ──────────────────────────────────────────────────────────

const failures = [];
let cases = 0;
function check(ok, message) {
  cases += 1;
  if (!ok) failures.push(message);
}

async function outcome(promise) {
  try {
    return { value: await promise };
  } catch (error) {
    // MACOS_EVIDENCE_VERBOSE=1 prints every refusal, so a reviewer can see each
    // negative control fail for its own reason rather than an incidental one.
    if (process.env.MACOS_EVIDENCE_VERBOSE) process.stderr.write(`  refused: ${error.message}\n`);
    return { error };
  }
}

// ── A. the reuse decision ───────────────────────────────────────────────────

async function decideIn(w, { mode = "auto", ref = "refs/heads/main", releaseVersion = "1.4.5" } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "macos-evidence-dir-"));
  try {
    return await outcome(decide(apiFor(w), {
      mode, repository: REPO, repositoryId: REPO_ID, sha: SHA, ref, releaseVersion, now: NOW, dir,
    }));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function reuseCases() {
  // Positive control.
  {
    const w = reuseWorld();
    const got = await decideIn(w);
    check(got.value?.source === "reuse" && got.value.evidence.artifact.id === 7001
      && got.value.evidence.run.attempt === 1 && got.value.evidence.version === "1.4.5",
    `select: the complete exact-main world was not reused: ${got.error?.message ?? JSON.stringify(got.value?.reason)}`);
    const back = mkdtempSync(join(tmpdir(), "macos-evidence-rb-"));
    const rb = await outcome(readback(apiFor(w), got.value?.evidence, { now: NOW, dir: back, releaseVersion: "1.4.5" }));
    check(rb.error === undefined, `readback: an unchanged world was refused: ${rb.error?.message}`);
    check((() => { try { return readFileSync(join(back, "Relayium.dmg"), "utf8"); } catch { return null; } })() === "signed dmg bytes",
      "readback: the payload was not extracted where the notarization job reads it");
    rmSync(back, { recursive: true, force: true });
    const built = await decideIn(w, { mode: "build" });
    check(built.value?.source === "build", "select: mode=build did not build");
  }

  // A "re-run failed jobs" attempt: the run is on attempt 2, one UI shard was
  // re-run in it, and signed-build is the attempt-1 job that already
  // succeeded. That is legitimate and must stay reusable.
  {
    const w = reuseWorld();
    w.run.run_attempt = 2;
    w.attempt.run_attempt = 2;
    w.runs[0] = { ...w.run };
    w.jobs[3].run_attempt = 2;
    w.history = { 1: { attempt: { ...w.run, run_attempt: 1, conclusion: "failure" }, jobs: clone(reuseWorld().jobs) } };
    const got = await decideIn(w);
    check(got.value?.source === "reuse" && got.value.evidence.jobs[4].runAttempt === 1
      && got.value.evidence.signedBuildOrigin?.attempt === 1,
      `select: a partial rerun keeping the attempt-1 signed-build was not reused: ${got.error?.message ?? got.value?.reason}`);
  }

  // The relabelled form GitHub actually returns (observed on publisher run
  // 36943045523, attempts 1 and 5): the carried signed-build is listed by the
  // latest attempt with that attempt's number, a new id, node id, created_at
  // and a null runner_group_id, but the SAME execution — times, labels and
  // steps. The provenance still names attempt 1, the attempt it ran in; the
  // origin is proved by reading attempt 1 itself.
  const relabelled = () => {
    const w = reuseWorld();
    const original = clone(w.jobs);
    w.run.run_attempt = 4;
    w.attempt.run_attempt = 4;
    w.runs[0] = { ...w.run };
    w.jobs = w.jobs.map((j, i) => ({ ...j, id: 9900 + i, run_attempt: 4, node_id: `CR_new${i}`,
      created_at: "2026-10-02T03:37:39Z", runner_group_id: null }));
    w.history = { 1: { attempt: { ...w.run, run_attempt: 1, conclusion: "failure" }, jobs: original } };
    return w;
  };
  {
    const got = await decideIn(relabelled(), { mode: "reuse" });
    check(got.value?.source === "reuse" && got.value.evidence.signedBuildOrigin?.attempt === 1
      && got.value.evidence.signedBuildOrigin?.jobId === 904,
    `select: a relabelled carried signed-build (latest 4, origin 1) was not reused: ${got.error?.message ?? got.value?.reason}`);
  }
  const notCarried = [
    ["the latest job re-executed (new times)", (w) => {
      w.jobs[4].started_at = "2026-10-02T03:38:00Z"; w.jobs[4].completed_at = "2026-10-02T03:50:00Z";
      w.artifacts[0].created_at = "2026-10-02T03:45:00Z"; // inside the new window: only continuity refuses
    }, /different execution/],
    ["one step changed", (w) => { w.jobs[4].steps[1].conclusion = "skipped"; }, /different execution/],
    ["a step reordered/duplicated", (w) => { w.jobs[4].steps[1].number = 1; }, /malformed, unordered or duplicate step/],
    ["another runner", (w) => { w.jobs[4].runner_name = "a"; w.history[1].jobs[4].runner_name = "b"; }, /different execution/],
    ["the original attempt unreadable", (w) => { delete w.history; }, /attempt 1 could not be read/],
    ["the original attempt lacks signed-build", (w) => { w.history[1].jobs.splice(4, 1); }, /lists 0 `signed-build`/],
    ["the original attempt lists it twice", (w) => { w.history[1].jobs.push({ ...w.history[1].jobs[4], id: 905 }); }, /lists 2 `signed-build`/],
    ["the original signed-build failed", (w) => { w.history[1].jobs[4].conclusion = "failure"; }, /not a completed success/],
    ["the original attempt is another commit", (w) => { w.history[1].attempt.head_sha = "b".repeat(40); }, /not a completed attempt/],
    ["the original attempt record is still running", (w) => { w.history[1].attempt.status = "in_progress"; }, /not a completed attempt/],
    ["the original inventory labels another attempt", (w) => { w.history[1].jobs[4].run_attempt = 2; }, /lists it as attempt 2/],
    ["the latest wrapper names a third attempt", (w) => { w.jobs[4].run_attempt = 2; }, /labelled attempt 2 in attempt 4/],
    ["a provenance naming attempt 2 that never ran it", (w) => {
      w.history[2] = { attempt: { ...w.run, run_attempt: 2, conclusion: "failure" }, jobs: w.history[1].jobs.filter((j) => j.name !== "signed-build") };
      w.zip = payload({ provenance: { runAttempt: "2" } });
      w.artifacts[0].digest = `sha256:${sha256(w.zip)}`;
    }, /lists 0 `signed-build`/],
  ];
  for (const [name, mutate, reason] of notCarried) {
    for (const mode of ["auto", "reuse"]) {
      const w = relabelled();
      mutate(w);
      const got = await decideIn(w, { mode });
      check(got.error instanceof Refused && reason.test(got.error.message),
        `select ${mode}: relabelled origin with ${name} must be refused for ${reason}, not `
        + `${got.value ? `treated as ${got.value.source}` : got.error?.message}`);
    }
  }

  // Unavailable evidence: auto rebuilds, reuse refuses.
  const unavailable = [
    ["no run for the SHA", (w) => { w.runs = []; }],
    ["a foreign repository's run", (w) => { w.runs[0] = { ...w.run, repository: { id: 1, full_name: "evil/relayium", fork: false } }; }],
    ["a fork's run", (w) => { w.runs[0] = { ...w.run, head_repository: { id: 2, full_name: "fork/relayium", fork: true } }; }],
    ["a pull_request run", (w) => { w.runs[0] = { ...w.run, event: "pull_request" }; }],
    ["a run on an ancestor commit", (w) => { w.runs[0] = { ...w.run, head_sha: "b".repeat(40) }; }],
    ["another workflow's run", (w) => { w.runs[0] = { ...w.run, path: ".github/workflows/ios.yml" }; }],
    ["two runs for the SHA", (w) => { w.runs.push({ ...w.run, id: 501 }); }],
    ["a pending new attempt", (w) => { w.run.status = "in_progress"; w.run.run_attempt = 2; w.runs[0] = { ...w.run }; }],
    ["a newer failed attempt", (w) => { w.run.conclusion = "failure"; w.run.run_attempt = 2; w.runs[0] = { ...w.run }; }],
    ["a run older than the freshness bound", (w) => { w.run.created_at = "2026-09-20T00:00:00Z"; w.run.run_started_at = w.run.created_at; w.runs[0] = { ...w.run }; }],
    ["a missing UI shard", (w) => { w.jobs = w.jobs.filter((j) => !j.name.startsWith("ui-smoke (device-inbox")); }],
    ["a skipped UI shard", (w) => { w.jobs[3].conclusion = "skipped"; }],
    ["a skipped signed-build", (w) => { w.jobs[4].conclusion = "skipped"; }],
    ["an unexpected extra job", (w) => { w.jobs.push({ ...w.jobs[0], id: 999, name: "smuggled" }); }],
    ["a missing artifact", (w) => { w.artifacts = []; }],
    ["an expired artifact", (w) => { w.artifacts[0].expired = true; }],
    ["an artifact about to expire", (w) => { w.artifacts[0].expires_at = "2026-10-01T19:00:00Z"; }],
    ["a duplicate (expired) artifact of the same name", (w) => { w.artifacts.push({ ...w.artifacts[0], id: 7000, expired: true }); }],
    ["a legacy provenance without schema", (w) => {
      w.zip = payload({ provenance: (p) => { const { schema, ...rest } = p; return rest; } });
      w.artifacts[0].digest = `sha256:${sha256(w.zip)}`;
    }],
    ["a release from a branch other than main", null],
    ["the artifact download is gone", (w) => { w.downloadStatus = 410; }],
  ];
  for (const [name, mutate] of unavailable) {
    const w = reuseWorld();
    if (mutate) mutate(w);
    const ref = mutate ? "refs/heads/main" : "refs/heads/feature";
    const auto = await decideIn(w, { ref });
    check(auto.value?.source === "build",
      `select auto: ${name} should fall back to a full build, got ${auto.error ? `error ${auto.error.message}` : auto.value?.source}`);
    const strict = await decideIn(w, { ref, mode: "reuse" });
    check(strict.error instanceof Refused,
      `select reuse: ${name} should fail an explicit reuse, got ${strict.value?.source ?? strict.error?.message}`);
  }

  // Wrong evidence: refused in EVERY mode, never rebuilt around.
  const wrongProvenance = (patch) => (w) => {
    w.zip = payload({ provenance: patch });
    w.artifacts[0].digest = `sha256:${sha256(w.zip)}`;
  };
  const refused = [
    ["a truncated run listing", (w) => { w.runsTotal = 2; }],
    ["an artifact of another run", (w) => { w.artifacts[0].workflow_run.id = 499; }],
    ["an artifact created outside signed-build", (w) => { w.artifacts[0].created_at = "2026-10-01T16:00:00Z"; }],
    ["an artifact digest mismatch", (w) => { w.zip = payload({ dmg: "tampered dmg" }); }],
    ["an extra payload file", (w) => { w.zip = payload({ extra: "evil.sh" }); w.artifacts[0].digest = `sha256:${sha256(w.zip)}`; }],
    ["a tampered generate_appcast", (w) => {
      w.zip = payload({ tool: "evil tool", provenance: { generateAppcastSha256: sha256(Buffer.from("generate_appcast bytes")) } });
      w.artifacts[0].digest = `sha256:${sha256(w.zip)}`;
    }],
    ["a malformed provenance", wrongProvenance(() => "{not json")],
    ["a v2 provenance without toolchain", wrongProvenance((p) => ({ ...p, toolchain: undefined }))],
    ["a provenance naming another run", wrongProvenance({ runId: "499" })],
    ["a provenance naming another attempt", wrongProvenance({ runAttempt: "2" })],
    ["a provenance from a foreign repository", wrongProvenance({ repositoryId: "1" })],
    ["a provenance from a pull_request event", wrongProvenance({ event: "pull_request" })],
    ["a provenance from another workflow", wrongProvenance({ workflowRef: `${REPO}/.github/workflows/macos-release.yml@refs/heads/main` })],
    ["a version other than the requested release", wrongProvenance({ version: "1.4.4", shareExtensionVersion: "1.4.4" })],
    ["a Share extension build mismatch", wrongProvenance({ shareExtensionBuild: "41" })],
    ["an App Store build masquerading as direct", wrongProvenance({ channel: "app-store" })],
    ["a universal build", wrongProvenance({ arch: "x86_64 arm64" })],
    ["another signing team", wrongProvenance({ teamId: "ABCDE12345" })],
    ["a reused build offered for reuse again", wrongProvenance({ signedBuildSource: "reused" })],
    ["a build made inside a release run", wrongProvenance({ releaseVersion: "1.4.5" })],
    // Job attempts, each with a provenance FORGED to match the bad value, so
    // only the attempt rule can refuse it.
    ["a signed-build job with no run_attempt (provenance forged as \"undefined\")", (w) => {
      delete w.jobs[4].run_attempt;
      wrongProvenance({ runAttempt: "undefined" })(w);
    }, /job 904 \(signed-build\) has run_attempt undefined/],
    ["a signed-build job with a string run_attempt", (w) => {
      w.jobs[4].run_attempt = "1";
    }, /job 904 \(signed-build\) has run_attempt "1"/],
    ["a signed-build job with a fractional run_attempt", (w) => {
      w.jobs[4].run_attempt = 1.5;
      wrongProvenance({ runAttempt: "1.5" })(w);
    }, /has run_attempt 1\.5/],
    ["a signed-build job with run_attempt 0", (w) => {
      w.jobs[4].run_attempt = 0;
      wrongProvenance({ runAttempt: "0" })(w);
    }, /has run_attempt 0/],
    ["a signed-build job from a future attempt", (w) => {
      w.jobs[4].run_attempt = 2;
      wrongProvenance({ runAttempt: "2" })(w);
    }, /job 904 \(signed-build\) has run_attempt 2; want an integer from 1 to the run's latest attempt 1/],
    ["another gate job with a null run_attempt", (w) => {
      w.jobs[0].run_attempt = null;
    }, /job 900 \(contract\) has run_attempt null/],
    ["a symlink payload member delivered through the API", (w) => {
      w.zip = zipOf([...without("Relayium.dmg"), { name: "Relayium.dmg", data: "/etc/hosts", mode: 0o120777 }]);
      w.artifacts[0].digest = `sha256:${sha256(w.zip)}`;
    }],
    ["a directory-only artifact delivered through the API", (w) => {
      w.zip = zipOf([{ name: "release-tools/", mode: 0o040755 }]);
      w.artifacts[0].digest = `sha256:${sha256(w.zip)}`;
    }],
    ["a provenance that names another DMG hash", wrongProvenance((p) => ({ ...p, dmgSha256: "f".repeat(64), signedDmgSha256: "f".repeat(64) }))],
  ];
  for (const [name, mutate, reason] of refused) {
    for (const mode of ["auto", "reuse"]) {
      const w = reuseWorld();
      mutate(w);
      const got = await decideIn(w, { mode });
      check(got.error instanceof Refused && (!reason || reason.test(got.error.message)),
        `select ${mode}: ${name} must be refused${reason ? ` for ${reason}` : ""}, not `
        + `${got.value ? `treated as ${got.value.source}` : got.error?.message}`);
    }
  }

  // The readback: anything that changed since the preflight froze it.
  const changed = [
    ["a new successful attempt after the preflight", (w) => {
      w.run.run_attempt = 2;
      w.attempt.run_attempt = 2;
      w.runs[0] = { ...w.run };
      w.jobs = w.jobs.map((j) => ({ ...j, run_attempt: 2 }));
      w.zip = payload({ provenance: { runAttempt: "2" } });
      w.artifacts[0].digest = `sha256:${sha256(w.zip)}`;
    }],
    ["a replaced artifact", (w) => { w.artifacts[0].id = 7002; }],
    ["an artifact that expired since", (w) => { w.artifacts[0].expired = true; }],
    ["a run that is no longer green", (w) => { w.run.conclusion = "failure"; w.runs[0] = { ...w.run }; }],
  ];
  for (const [name, mutate] of changed) {
    const w = reuseWorld();
    const first = await decideIn(w);
    mutate(w);
    const dir = mkdtempSync(join(tmpdir(), "macos-evidence-rb-"));
    const got = await outcome(readback(apiFor(w), first.value?.evidence, { now: NOW, dir, releaseVersion: "1.4.5" }));
    rmSync(dir, { recursive: true, force: true });
    check(got.error instanceof Refused, `readback: ${name} must be refused, got ${got.error?.message ?? "acceptance"}`);
  }
}

// ── A2. the payload archive and where it is written ─────────────────────────

/**
 * A ZIP written byte by byte, so a control can carry exactly the defect it
 * names — a traversal or NUL in a name, a symlink or FIFO mode, a duplicate,
 * a CRC that lies — none of which the `zip` CLI will produce on request.
 * Each entry: { name, data, mode (unix st_mode; null = MS-DOS host),
 * dos, method, flags, crc, localName, version }.
 */
function zipOf(entries, { trailing = "" } = {}) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.isBuffer(e.name) ? e.name : Buffer.from(e.name, "latin1");
    const localName = e.localName === undefined ? name : Buffer.from(e.localName, "latin1");
    const raw = Buffer.from(e.data ?? "");
    const method = e.method ?? 0;
    const body = method === 8 ? deflateRawSync(raw) : raw;
    const crc = e.crc ?? crc32(raw);
    const flags = e.flags ?? 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(localName.length, 26);
    locals.push(local, localName, body);
    const host = e.mode === null ? 0 : 3;
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE((host << 8) | 20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(name.length, 28);
    const mode = e.mode === undefined ? 0o100644 : e.mode;
    central.writeUInt32LE((((mode ?? 0) << 16) | (e.dos ?? 0)) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += 30 + localName.length + body.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end, Buffer.from(trailing)]);
}

const FOUR = () => [
  { name: "Relayium.dmg", data: "dmg" },
  { name: "Relayium.dmg.sha256", data: "sum" },
  { name: "provenance.json", data: "{}" },
  { name: "release-tools/generate_appcast", data: "tool", mode: 0o100755 },
];
const without = (name) => FOUR().filter((e) => e.name !== name);

function archiveCases() {
  const accepts = [
    ["four stored regular files", zipOf(FOUR())],
    ["four deflated regular files", zipOf(FOUR().map((e) => ({ ...e, method: 8 })))],
    ["the canonical release-tools/ directory entry", zipOf([{ name: "release-tools/", mode: 0o040755 }, ...FOUR()])],
    ["an MS-DOS-host archive of four files", zipOf(FOUR().map((e) => ({ ...e, mode: null })))],
  ];
  for (const [name, zip] of accepts) {
    const got = (() => { try { return readPayloadArchive(zip); } catch (error) { return error; } })();
    check(got instanceof Map && got.size === 4, `archive: ${name} must be accepted, got ${got?.message}`);
  }
  const symlinkZip = (() => {
    const dir = mkdtempSync(join(tmpdir(), "macos-evidence-symlink-"));
    mkdirSync(join(dir, "release-tools"));
    for (const f of ["Relayium.dmg.sha256", "provenance.json", "release-tools/generate_appcast"]) writeFileSync(join(dir, f), f);
    symlinkSync("/etc/hosts", join(dir, "Relayium.dmg"));
    const made = spawnSync("zip", ["-q", "-X", "-y", "a.zip", "Relayium.dmg", "Relayium.dmg.sha256",
      "provenance.json", "release-tools/generate_appcast"], { cwd: dir });
    const bytes = made.status === 0 ? readFileSync(join(dir, "a.zip")) : null;
    rmSync(dir, { recursive: true, force: true });
    return bytes;
  })();
  check(symlinkZip !== null, "archive: the `zip -y` symlink archive could not be built");
  const refusals = [
    ["a directory-only archive", zipOf([{ name: "release-tools/", mode: 0o040755 }]), /lacks Relayium\.dmg, Relayium\.dmg\.sha256, provenance\.json, release-tools\/generate_appcast/],
    ["an archive with no entries", zipOf([]), /lacks Relayium\.dmg/],
    ["an extra directory entry", zipOf([...FOUR(), { name: "evil/", mode: 0o040755 }]), /holds directory evil\/; only release-tools\/ may appear/],
    ["a nested directory entry", zipOf([...FOUR(), { name: "release-tools/sub/", mode: 0o040755 }]), /holds directory release-tools\/sub\//],
    ["a traversal directory entry", zipOf([...FOUR(), { name: "release-tools/../", mode: 0o040755 }]), /contains a traversal segment/],
    ["a traversal file name", zipOf([...without("Relayium.dmg"), { name: "../Relayium.dmg", data: "dmg" }]), /contains a traversal segment/],
    ["a dot segment", zipOf([...without("Relayium.dmg"), { name: "./Relayium.dmg", data: "dmg" }]), /contains a traversal segment/],
    ["an absolute name", zipOf([...without("Relayium.dmg"), { name: "/Relayium.dmg", data: "dmg" }]), /contains an absolute path/],
    ["a drive-letter name", zipOf([...without("Relayium.dmg"), { name: "C:/Relayium.dmg", data: "dmg" }]), /contains an absolute path/],
    ["a backslash name", zipOf([...without("release-tools/generate_appcast"), { name: "release-tools\\generate_appcast", data: "tool" }]), /contains a backslash/],
    ["a NUL in a name", zipOf([...without("Relayium.dmg"), { name: Buffer.from("Relayium.dmg\0.txt", "latin1"), data: "dmg" }]), /contains a NUL byte/],
    ["an empty path segment", zipOf([...without("release-tools/generate_appcast"), { name: "release-tools//generate_appcast", data: "tool" }]), /contains an empty path segment/],
    ["a duplicate payload name", zipOf([...FOUR(), { name: "Relayium.dmg", data: "other" }]), /names Relayium\.dmg twice/],
    ["a duplicate directory entry", zipOf([{ name: "release-tools/", mode: 0o040755 }, { name: "release-tools/", mode: 0o040755 }, ...FOUR()]), /names release-tools\/ twice/],
    ["a symlink payload member", zipOf([...without("Relayium.dmg"), { name: "Relayium.dmg", data: "/etc/hosts", mode: 0o120777 }]), /Relayium\.dmg is a symlink, not a regular file/],
    ["a symlink tool member", zipOf([...without("release-tools/generate_appcast"), { name: "release-tools/generate_appcast", data: "/bin/sh", mode: 0o120755 }]), /generate_appcast is a symlink, not a regular file/],
    ["a symlink release-tools/ directory", zipOf([{ name: "release-tools/", data: "", mode: 0o120755 }, ...FOUR()]), /release-tools\/ is a symlink, not a directory/],
    ["a real `zip -y` symlink archive", symlinkZip ?? Buffer.alloc(0), /Relayium\.dmg is a symlink, not a regular file/],
    ["a FIFO member", zipOf([...without("provenance.json"), { name: "provenance.json", data: "", mode: 0o010644 }]), /provenance\.json is a special \(mode 10644\), not a regular file/],
    ["a character-device member", zipOf([...without("provenance.json"), { name: "provenance.json", data: "", mode: 0o020644 }]), /is a special \(mode 20644\)/],
    ["an untyped Unix member", zipOf([...without("provenance.json"), { name: "provenance.json", data: "{}", mode: 0o000644 }]), /provenance\.json is a untyped, not a regular file/],
    ["an MS-DOS directory attribute on a file name", zipOf([...without("provenance.json"), { name: "provenance.json", data: "", mode: null, dos: 0x10 }]), /provenance\.json is a directory, not a regular file/],
    ["an unexpected extra file", zipOf([...FOUR(), { name: "evil.sh", data: "x" }]), /holds evil\.sh; want exactly/],
    ["a missing payload file", zipOf(without("provenance.json")), /lacks provenance\.json/],
    ["an encrypted member", zipOf([...without("Relayium.dmg"), { name: "Relayium.dmg", data: "dmg", flags: 1 }]), /is encrypted/],
    ["an unsupported compression method", zipOf([...without("Relayium.dmg"), { name: "Relayium.dmg", data: "dmg", method: 12 }]), /unsupported compression method 12/],
    ["a CRC that lies", zipOf([...without("Relayium.dmg"), { name: "Relayium.dmg", data: "dmg", crc: 1 }]), /fails its CRC/],
    ["a local header naming another file", zipOf([...without("Relayium.dmg"), { name: "Relayium.dmg", data: "dmg", localName: "evil.dmg" }]), /local header names another file/],
    ["bytes after the end record", zipOf(FOUR(), { trailing: "junk" }), /bytes after its end record/],
    ["not a zip at all", Buffer.from("this is not an archive at all, just text"), /no end-of-central-directory record/],
  ];
  for (const [name, zip, reason] of refusals) {
    let error = null;
    try { readPayloadArchive(zip); } catch (e) { error = e; }
    check(error instanceof Refused && reason.test(error.message),
      `archive: ${name} must be refused for ${reason}, got ${error ? error.message : "acceptance"}`);
    if (process.env.MACOS_EVIDENCE_VERBOSE && error) process.stderr.write(`  refused (${name}): ${error.message}\n`);
  }
}

function destinationCases() {
  const files = readPayloadArchive(zipOf(FOUR()));
  const scratch = mkdtempSync(join(tmpdir(), "macos-evidence-dest-"));
  const victim = join(scratch, "victim");
  const note = (name, error) => {
    if (process.env.MACOS_EVIDENCE_VERBOSE && error) process.stderr.write(`  refused (${name}): ${error.message}\n`);
  };
  try {
    // Positive: an absent directory is created fresh, 0700, and every file
    // written is a regular single-link file whose on-disk hash is recorded.
    const fresh = join(scratch, "fresh");
    const hashes = installPayload(files, fresh);
    check((statSync(fresh).mode & 0o777) === 0o700 && Object.keys(hashes).length === 4
      && hashes["Relayium.dmg"] === createHash("sha256").update("dmg").digest("hex"),
    "destination: a fresh payload directory was not created 0700 with on-disk hashes");
    // Positive: an existing real directory where no payload path exists yet.
    const existing = join(scratch, "existing");
    mkdirSync(existing);
    writeFileSync(join(existing, "unrelated"), "x");
    let ok = null;
    try { installPayload(files, existing); } catch (e) { ok = e; }
    check(ok === null, `destination: an existing directory without payload paths was refused: ${ok?.message}`);

    const refusals = [
      ["a preexisting target symlink to a victim file", (d) => symlinkSync(victim, join(d, "Relayium.dmg")), /Relayium\.dmg already exists \(a symlink\)/],
      ["a preexisting dangling target symlink", (d) => symlinkSync(join(scratch, "nowhere"), join(d, "provenance.json")), /provenance\.json already exists \(a symlink\)/],
      ["a preexisting release-tools symlink", (d) => symlinkSync(scratch, join(d, "release-tools")), /release-tools already exists \(a symlink\)/],
      ["a preexisting regular target", (d) => writeFileSync(join(d, "Relayium.dmg.sha256"), "old"), /Relayium\.dmg\.sha256 already exists \(a file or directory\)/],
      ["a preexisting release-tools directory", (d) => mkdirSync(join(d, "release-tools")), /release-tools already exists \(a file or directory\)/],
    ];
    for (const [name, plant, reason] of refusals) {
      writeFileSync(victim, "victim\n");
      const d = mkdtempSync(join(scratch, "d-"));
      plant(d);
      let error = null;
      try { installPayload(files, d); } catch (e) { error = e; }
      note(name, error);
      check(error instanceof Refused && reason.test(error.message),
        `destination: ${name} must be refused for ${reason}, got ${error ? error.message : "acceptance"}`);
      check(readFileSync(victim, "utf8") === "victim\n", `destination: ${name} wrote through to the victim`);
      check(!lstatSync(d).isSymbolicLink() && (() => { try { return readFileSync(join(d, "Relayium.dmg"), "utf8") !== "dmg"; } catch { return true; } })(),
        `destination: ${name} still wrote the payload`);
    }
    {
      const real = mkdtempSync(join(scratch, "real-"));
      const link = join(scratch, "linked-dir");
      symlinkSync(real, link);
      let error = null;
      try { installPayload(files, link); } catch (e) { error = e; }
      note("a destination that is itself a symlink", error);
      check(error instanceof Refused && /linked-dir exists and is not a real directory/.test(error.message),
        `destination: a symlinked destination must be refused, got ${error?.message ?? "acceptance"}`);
    }
    // After installation: a payload file swapped for a symlink, or hard-linked,
    // is refused before anything reads it.
    for (const [name, tamper, reason] of [
      ["a payload file swapped for a symlink after install", (d) => { rmSync(join(d, "Relayium.dmg")); symlinkSync(victim, join(d, "Relayium.dmg")); }, /Relayium\.dmg is not a regular single-link file/],
      ["a hard-linked payload file", (d) => linkSync(join(d, "provenance.json"), join(scratch, `hl-${Date.now()}`)), /provenance\.json is not a regular single-link file/],
      ["a payload file replaced by a directory", (d) => { rmSync(join(d, "Relayium.dmg.sha256")); mkdirSync(join(d, "Relayium.dmg.sha256")); }, /Relayium\.dmg\.sha256 is not a regular single-link file/],
      ["a payload file whose bytes changed", (d) => writeFileSync(join(d, "Relayium.dmg"), "evil"), /Relayium\.dmg on disk is not the verified bytes/],
    ]) {
      const d = join(scratch, `t-${Math.random().toString(16).slice(2)}`);
      installPayload(files, d);
      tamper(d);
      let error = null;
      try { hashPayload(d, files); } catch (e) { error = e; }
      note(name, error);
      check(error instanceof Refused && reason.test(error.message),
        `destination: ${name} must be refused for ${reason}, got ${error ? error.message : "acceptance"}`);
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

// ── A3. executed, not witnessed: the producer run's job and step records ────

const jobOf = (w, id) => w.jobs.find((j) => (["evidence", "screen", "certify-macos"].includes(id) ? j.name === id
  : j.name === { contract: "contract", test: "test", "signed-build": "signed-build" }[id]
    || (id === "ui-smoke/app-shell" && j.name.startsWith("ui-smoke (app-shell, "))
    || (id === "ui-smoke/device-inbox" && j.name.startsWith("ui-smoke (device-inbox, "))));
const setStep = (job, name, conclusion) => { job.steps.find((st) => st.name === name).conclusion = conclusion; };
/** A UI shard that took the witness path instead of executing. */
const witnessed = (job, { mac = false } = {}) => {
  if (!mac) job.labels = ["ubuntu-latest"];
  for (const st of job.steps) {
    if (WITNESS.includes(st.name)) st.conclusion = "success";
    else if (!["Set up job", "Complete job"].includes(st.name)) st.conclusion = "skipped";
  }
};

async function executionCases() {
  // Positives: the legacy five-job producer, and the canonical adoption's five
  // full native jobs plus exactly its three auxiliary jobs, in every final
  // state those auxiliaries legitimately end in on a main push the merged pull
  // request did not prove (the screen said no / was red / the probe ran or failed).
  const FROZEN = { witnessedContract: true };
  const EVENT = { eventContract: true };
  for (const [name, adopted, shape, jobs, mutate] of [
    ["a legacy five-job full producer", false, "legacy", 5, () => {}],
    ["a canonical adopted producer (screen no, certify skipped) that executed natively", true, ADOPTED_SHAPE, 8, () => {}],
    ["a canonical adopted producer whose fresh contract ran on its event's runner", true, ADOPTED_SHAPE, 8, (w) => {
      check(JSON.stringify(jobOf(w, "contract").steps.map((st) => st.name)) === JSON.stringify(REAL_STEPS.contract),
        "execution: the current adoption's contract fixture is not exactly its original steps");
    }],
    // Every signed build produced while the fresh contract still read the caller's event: that adoption, whole.
    ["a producer under the frozen event-contract adoption", EVENT, EVENT_CONTRACT_SHAPE, 8, () => {}],
    ["a frozen event-contract producer whose contract ran on macOS", EVENT, EVENT_CONTRACT_SHAPE, 8, (w) => { jobOf(w, "contract").labels = ["macos-15"]; }],
    ["a frozen event-contract producer whose certify failed (never red)", EVENT, EVENT_CONTRACT_SHAPE, 8, (w) => { jobOf(w, "certify-macos").conclusion = "failure"; }],
    // Every signed build produced before the contract became fresh: the frozen previous adoption, whole.
    ["a producer under the frozen witnessed-contract adoption", FROZEN, WITNESSED_CONTRACT_SHAPE, 8, () => {}],
    // Built before ui-smoke stopped waiting for test: the frozen previous adoption with that triple, whole.
    ["a frozen witnessed-contract producer under the legacy ui-smoke triple", FROZEN, WITNESSED_CONTRACT_SHAPE, 8, (w) => { w.workflowText = legacyUiSmokeText(); }],
    ["a canonical adopted producer whose screen failed (never red)", true, ADOPTED_SHAPE, 8, (w) => { jobOf(w, "screen").conclusion = "failure"; }],
    ["a canonical adopted producer whose screen was skipped", true, ADOPTED_SHAPE, 8, (w) => { jobOf(w, "screen").conclusion = "skipped"; }],
    ["a canonical adopted producer whose certify ran but the proof did not cover", true, ADOPTED_SHAPE, 8, (w) => { jobOf(w, "certify-macos").conclusion = "success"; }],
    ["a canonical adopted producer whose certify failed (never red)", true, ADOPTED_SHAPE, 8, (w) => { jobOf(w, "certify-macos").conclusion = "failure"; }],
    ["a frozen witnessed-contract producer whose certify failed (never red)", FROZEN, WITNESSED_CONTRACT_SHAPE, 8, (w) => { jobOf(w, "certify-macos").conclusion = "failure"; }],
  ]) {
    const w = reuseWorld(typeof adopted === "object" ? adopted : { adopted });
    // A stale anchor throws (never a silent no-op); it is reported, not fatal to the suite.
    try { mutate(w); } catch (err) { check(false, `execution: ${name}: ${err.message}`); continue; }
    const got = await decideIn(w);
    check(got.value?.source === "reuse" && got.value.evidence.workflow.shape === shape
      && got.value.evidence.jobs.length === jobs,
    `execution: ${name} must be reused, got ${got.error?.message ?? got.value?.reason}`);
    if (adopted !== false) {
      check(JSON.stringify(got.value?.evidence?.jobs?.slice(5).map((j) => j.name) ?? null) === JSON.stringify(["screen", "certify-macos", "evidence"]),
        `execution: ${name}: the three auxiliary jobs are not bound into the evidence`);
    }
  }
  {
    // The frozen evidence binds the auxiliary jobs too: a readback that finds
    // the screen in another final state is a different run record.
    const w = reuseWorld({ adopted: true });
    const first = await decideIn(w);
    jobOf(w, "certify-macos").conclusion = "failure";
    const again = await decideIn(w);
    check(Boolean(first.value?.evidence && again.value?.evidence) && evidenceIdentity(first.value.evidence) !== evidenceIdentity(again.value.evidence),
      "execution: the auxiliary jobs' final states are not part of the frozen evidence identity");
  }
  {
    // A partial rerun under the adoption: one UI shard re-ran and EXECUTED in
    // attempt 2; every other job is its full attempt-1 record.
    const w = reuseWorld({ adopted: true });
    w.history = { 1: { attempt: { ...w.run, run_attempt: 1, conclusion: "failure" }, jobs: clone(w.jobs) } };
    w.run.run_attempt = 2;
    w.attempt.run_attempt = 2;
    w.runs[0] = { ...w.run };
    jobOf(w, "ui-smoke/device-inbox").run_attempt = 2;
    const got = await decideIn(w);
    check(got.value?.source === "reuse", `execution: a full partial rerun must be reused, got ${got.error?.message}`);
  }

  const app = "ui-smoke/app-shell";
  const smoke = "Run macOS product-flow UI smoke (app-shell)";
  const cases = [
    ["an omitted smoke step", true, (w) => { const j = jobOf(w, app); j.steps = j.steps.filter((st) => st.name !== smoke); }, /has 0 "Run macOS product-flow UI smoke \(app-shell\)" step\(s\)/],
    ["a skipped smoke step", true, (w) => setStep(jobOf(w, app), smoke, "skipped"), /did not execute "Run macOS product-flow UI smoke \(app-shell\)" \(completed\/skipped\)/],
    ["a duplicated smoke step", true, (w) => { const j = jobOf(w, app); j.steps.push({ ...j.steps.find((st) => st.name === smoke) }); }, /has 2 "Run macOS product-flow UI smoke \(app-shell\)" step\(s\)/],
    ["a failed smoke step under a green job", true, (w) => setStep(jobOf(w, app), smoke, "failure"), /did not execute "Run macOS product-flow UI smoke \(app-shell\)" \(completed\/failure\)/],
    ["the other shard's suite run in the app-shell job", true, (w) => jobOf(w, app).steps.push({ name: "Run macOS product-flow UI smoke (device-inbox)", status: "completed", conclusion: "success" }), /ran "Run macOS product-flow UI smoke \(device-inbox\)" \(success\)/],
    ["a witnessed contract job", true, (w) => witnessed(jobOf(w, "contract")), /job 900 \(contract\) did not execute "Validate release contract" \(completed\/skipped\)/],
    ["a witnessed contract job under the frozen adoption", FROZEN, (w) => witnessed(jobOf(w, "contract")), /job 900 \(contract\) did not execute "Validate release contract" \(completed\/skipped\)/],
    // The current contract has no witness path: a witness step record, even skipped, is foreign to it.
    ["a skipped witness step in the always-fresh contract", true, (w) => jobOf(w, "contract").steps.unshift({ name: WITNESS[0], status: "completed", conclusion: "skipped" }), /job 900 \(contract\) ran "Check out the verifier \(witness path only\)" \(skipped\)/],
    ["a skipped confirm step in the always-fresh contract", true, (w) => jobOf(w, "contract").steps.unshift({ name: WITNESS[2], status: "completed", conclusion: "skipped" }), /job 900 \(contract\) ran "Witness — the pull request's full proof covers this job" \(skipped\)/],
    ["a fresh contract that ran on a macOS runner it never picks for a push", true, (w) => { jobOf(w, "contract").labels = ["ubuntu-latest", "macos-15"]; }, /job 900 \(contract\) ran on \["ubuntu-latest","macos-15"\]/],
    // Never a mix of the two adoptions, and never an unknown third.
    ["the current evidence job beside a witnessed contract", true, (w) => { w.workflowText = withAfterSteps(w.workflowText, "contract", CANONICAL_WITNESS_STEPS); }, /not the canonical one/],
    ["the frozen evidence job beside a fresh contract", FROZEN, (w) => { w.workflowText = withoutWitness(w.workflowText, "contract"); }, /not the canonical one/],
    // Never a mix of contract generations: each runner only beside its own release branch.
    ["the current release branch beside the event runner", true, (w) => { w.workflowText = withEventRunsOn(w.workflowText); }, /not the canonical one/],
    ["the event release branch beside the current runner", true, (w) => { w.workflowText = withEventBranch(w.workflowText); }, /not the canonical one/],
    ["the frozen event contract with the current runner", EVENT, (w) => { w.workflowText = withIntentRunsOn(w.workflowText); }, /not the canonical one/],
    ["the frozen event contract with the current branch", EVENT, (w) => { w.workflowText = withIntentBranch(w.workflowText); }, /not the canonical one/],
    ["the frozen witnessed contract with the current runner", FROZEN, (w) => { w.workflowText = withIntentRunsOn(w.workflowText); }, /not the canonical one/],
    ["the frozen witnessed contract with the current branch", FROZEN, (w) => { w.workflowText = withIntentBranch(w.workflowText); }, /not the canonical one/],
    ["the frozen witnessed contract with both current lines", FROZEN, (w) => { w.workflowText = withIntentBranch(withIntentRunsOn(w.workflowText)); }, /not the canonical one/],
    ["the frozen event contract with a witnessed contract", EVENT, (w) => { w.workflowText = withAfterSteps(w.workflowText, "contract", CANONICAL_WITNESS_STEPS); }, /not the canonical one/],
    ["the frozen event contract with the frozen evidence job", EVENT, (w) => { w.workflowText = replaceOnce(w.workflowText, CANONICAL_EVIDENCE_JOB.join("\n") + "\n", WITNESSED_CONTRACT_EVIDENCE_JOB.join("\n") + "\n"); }, /not the canonical one/],
    ["the frozen event contract with the legacy ui-smoke triple", EVENT, (w) => { w.workflowText = replaceOnce(w.workflowText, UI_SMOKE_TRIPLE(CANONICAL_JOB_CONDITIONS["ui-smoke"]), UI_SMOKE_TRIPLE(LEGACY_ADOPTED_UI_SMOKE_CONDITIONS)); }, /not the canonical one/],
    ["a skipped witness step in the frozen event contract", EVENT, (w) => jobOf(w, "contract").steps.unshift({ name: WITNESS[0], status: "completed", conclusion: "skipped" }), /job 900 \(contract\) ran "Check out the verifier \(witness path only\)" \(skipped\)/],
    ["a release branch that drops a check inside the current contract", true, (w) => { w.workflowText = replaceOnce(w.workflowText, "              [ \"$NOTARIZE\" = true ] || exit 1\n", ""); }, /not the canonical one/],
    ["a release branch that drops the readiness check inside the frozen event contract", EVENT, (w) => { w.workflowText = replaceOnce(w.workflowText, "              node apps/mac/scripts/check-release-readiness.mjs --require-approved\n", ""); }, /not the canonical one/],
    ["the frozen evidence job inside the current adoption", true, (w) => { w.workflowText = replaceOnce(w.workflowText, CANONICAL_EVIDENCE_JOB.join("\n") + "\n", WITNESSED_CONTRACT_EVIDENCE_JOB.join("\n") + "\n"); }, /not the canonical one/],
    ["the legacy ui-smoke triple on the current adoption", true, (w) => { w.workflowText = replaceOnce(w.workflowText, UI_SMOKE_TRIPLE(CANONICAL_JOB_CONDITIONS["ui-smoke"]), UI_SMOKE_TRIPLE(LEGACY_ADOPTED_UI_SMOKE_CONDITIONS)); }, /not the canonical one/],
    ["a fresh contract whose steps still read the decision", true, (w) => { w.workflowText = replaceOnce(w.workflowText, "      - name: Validate release contract\n", "      - name: Validate release contract\n        if: needs.evidence.outputs.reuse != 'true'\n"); }, /not the canonical one/],
    ["a fresh contract that still captures a certificate", true, (w) => { w.workflowText = replaceOnce(w.workflowText, "\n  test:\n", "\n      - name: Certify this job's toolchain\n        run: node scripts/ci/ci-evidence-toolchain.mjs capture --role source --profile linux-base --lane macos --job contract\n  test:\n"); }, /not the canonical one/],
    ["a fresh contract that dropped !cancelled()", true, (w) => { w.workflowText = replaceOnce(w.workflowText, "  contract:\n    needs: evidence\n    if: ${{ !cancelled() }}\n", "  contract:\n    needs: evidence\n"); }, /not the canonical one/],
    ["a fresh contract pinned to one runner", true, (w) => { w.workflowText = replaceOnce(w.workflowText, CANONICAL_JOB_CONDITIONS.contract[2], "    runs-on: ubuntu-latest"); }, /not the canonical one/],
    ["an unknown evidence job (neither adoption's)", true, (w) => { w.workflowText = replaceOnce(w.workflowText, CANONICAL_EVIDENCE_JOB.join("\n") + "\n", CANONICAL_EVIDENCE_JOB.filter((l) => !l.includes("retention-days")).join("\n") + "\n"); }, /not the canonical one/],
    ["a signed-build that never packaged", false, (w) => { const j = jobOf(w, "signed-build"); j.steps = j.steps.filter((st) => st.name !== "Package and verify DMG"); }, /\(signed-build\) has 0 "Package and verify DMG" step\(s\)/],
    ["a signed-build on Ubuntu", false, (w) => { jobOf(w, "signed-build").labels = ["ubuntu-latest"]; }, /\(signed-build\) ran on \["ubuntu-latest"\]/],
    ["a job with no step records", false, (w) => { delete jobOf(w, "test").steps; }, /\(test\) reports no step records/],
    ["a malformed step record", false, (w) => { jobOf(w, "test").steps.push({ name: 7 }); }, /\(test\) has a malformed step record/],
    ["a witness step on the legacy definition, even skipped", false, (w) => jobOf(w, "test").steps.unshift({ name: WITNESS[0], status: "completed", conclusion: "skipped" }), /ran "Check out the verifier \(witness path only\)" \(skipped\)/],
    ["an evidence job missing under the adoption", true, (w) => { w.jobs = w.jobs.filter((j) => j.name !== "evidence"); }, /has 0 `evidence` job\(s\); want exactly one/],
    ["a skipped evidence job", true, (w) => { jobOf(w, "evidence").conclusion = "skipped"; }, /`evidence` job is completed\/skipped/],
    ["a failed evidence job", true, (w) => { jobOf(w, "evidence").conclusion = "failure"; }, /`evidence` job is completed\/failure/],
    ["a duplicated evidence job", true, (w) => { w.jobs.push({ ...jobOf(w, "evidence"), id: 898 }); }, /has 2 `evidence` job\(s\)/],
    ["a screen job missing under the adoption", true, (w) => { w.jobs = w.jobs.filter((j) => j.name !== "screen"); }, /has 0 `screen` job\(s\); want exactly one/],
    ["a certify-macos job missing under the adoption", true, (w) => { w.jobs = w.jobs.filter((j) => j.name !== "certify-macos"); }, /has 0 `certify-macos` job\(s\); want exactly one/],
    ["a duplicated screen job", true, (w) => { w.jobs.push({ ...jobOf(w, "screen"), id: 896 }); }, /has 2 `screen` job\(s\)/],
    ["a duplicated certify-macos job", true, (w) => { w.jobs.push({ ...jobOf(w, "certify-macos"), id: 896 }); }, /has 2 `certify-macos` job\(s\)/],
    ["a cancelled certify-macos job", true, (w) => { jobOf(w, "certify-macos").conclusion = "cancelled"; }, /`certify-macos` job is completed\/cancelled; want completed success\/failure\/skipped/],
    ["a screen job still in progress", true, (w) => { Object.assign(jobOf(w, "screen"), { status: "in_progress", conclusion: null }); }, /`screen` job is in_progress\/null/],
    ["a screen job on the legacy definition", false, (w) => { w.jobs.push({ ...reuseWorld({ adopted: true }).jobs.find((j) => j.name === "screen") }); }, /has unexpected jobs: screen/],
    ["a certify job of another family under the adoption", true, (w) => { w.jobs.push({ ...jobOf(w, "certify-macos"), id: 895, name: "certify-windows" }); }, /has unexpected jobs: certify-windows/],
    ["an evidence job that never decided", true, (w) => { const j = jobOf(w, "evidence"); j.steps = j.steps.filter((st) => !st.name.startsWith("Does the merged")); }, /has 0 "Does the merged pull request's full proof cover this main tree\?" step/],
    ["an evidence job on macOS", true, (w) => { jobOf(w, "evidence").labels = ["macos-15"]; }, /\(evidence\) ran on \["macos-15"\]/],
    ["an evidence job on the legacy definition", false, (w) => { w.jobs.push({ ...reuseWorld({ adopted: true }).jobs.find((j) => j.name === "evidence") }); }, /has unexpected jobs: evidence/],
    ["an unknown ninth job under the adoption", true, (w) => { w.jobs.push({ ...jobOf(w, "test"), id: 890, name: "smuggled" }); }, /has unexpected jobs: smuggled/],
    ["a non-canonical adoption (evidence job widened)", true, (w) => { w.workflowText = w.workflowText.replace("      pull-requests: read\n    outputs:", "      pull-requests: write\n    outputs:"); }, /carries a PR→main evidence adoption that is not the canonical one/],
    ["a non-canonical adoption (signed-build reads the decision)", true, (w) => { w.workflowText = w.workflowText.replace("  signed-build:\n    needs: [test, contract]", "  signed-build:\n    needs: [test, contract, evidence]"); }, /not the canonical one/],
    ["a non-canonical adoption (signed-build witnessed, conditions intact)", true, (w) => { const at = "  signed-build:\n" + CANONICAL_JOB_CONDITIONS["signed-build"].join("\n"); const steps = w.workflowText.indexOf("    steps:\n", w.workflowText.indexOf(at)) + "    steps:\n".length; w.workflowText = w.workflowText.slice(0, steps) + CANONICAL_WITNESS_STEPS.join("\n") + "\n" + w.workflowText.slice(steps); }, /not the canonical one/],
    ["a non-canonical adoption (an extra job block in the definition)", true, (w) => { w.workflowText = w.workflowText.replace("\n  signed-build:\n", "\n  smuggled:\n    runs-on: ubuntu-latest\n    steps:\n      - run: true\n  signed-build:\n"); }, /not the canonical one/],
    ["a non-canonical adoption (screen widened)", true, (w) => { w.workflowText = w.workflowText.replace("      eligible: ${{ steps.screen.outputs.eligible }}", "      eligible: true"); }, /not the canonical one/],
    ["a non-canonical adoption (certify on Ubuntu)", true, (w) => { w.workflowText = w.workflowText.replace("  certify-macos:\n    needs: screen\n", "  certify-macos:\n    needs: screen\n    runs-on: ubuntu-latest\n"); }, /not the canonical one/],
    ["a non-canonical adoption (outputs promoted from verify, not the handover)", true, (w) => { w.workflowText = w.workflowText.replace("      reuse: ${{ steps.handover.outputs.reuse }}", "      reuse: ${{ steps.verify.outputs.reuse }}"); }, /not the canonical one/],
    ["a non-canonical adoption (contract on implicit success())", true, (w) => { w.workflowText = w.workflowText.replace(/(  contract:\n(?:.*\n)*?)    if: \$\{\{ !cancelled\(\) \}\}\n/, "$1"); }, /not the canonical one/],
    ["a non-canonical adoption (signed-build without !cancelled())", true, (w) => { const at = "  signed-build:\n" + CANONICAL_JOB_CONDITIONS["signed-build"].join("\n"); w.workflowText = w.workflowText.replace(at, at.replace("${{ !cancelled() && needs.test.result == 'success' && needs.contract.result == 'success' && (", "${{ (")); }, /not the canonical one/],
    ["a non-canonical adoption (ui-smoke stops waiting for its own gates)", true, (w) => { w.workflowText = replaceOnce(w.workflowText, "    needs: [contract, evidence]", "    needs: evidence"); }, /not the canonical one/],
    ["a non-canonical adoption (legacy ui-smoke needs, current condition)", true, (w) => { w.workflowText = replaceOnce(w.workflowText, "    needs: [contract, evidence]", LEGACY_ADOPTED_UI_SMOKE_CONDITIONS[0]); }, /not the canonical one/],
    ["a non-canonical adoption (current ui-smoke needs, legacy condition)", true, (w) => { w.workflowText = replaceOnce(w.workflowText, CANONICAL_JOB_CONDITIONS["ui-smoke"][1], LEGACY_ADOPTED_UI_SMOKE_CONDITIONS[1]); }, /not the canonical one/],
    ["the revision-3 six-job adoption (no screen, no certify, no handover)", true, (w) => { w.workflowText = w.workflowText.replace(CANONICAL_SCREEN_JOB.join("\n") + "\n" + CANONICAL_CERTIFY_JOB.join("\n") + "\n", ""); }, /not the canonical one/],
    ["a release fallback (workflow_dispatch) run, full but not a push", true, (w) => { w.runs[0] = { ...w.run, event: "workflow_dispatch" }; }, /no push run of \.github\/workflows\/macos\.yml on main exists/],
  ];
  for (const [name, adopted, mutate, reason] of cases) {
    for (const mode of ["auto", "reuse"]) {
      const w = reuseWorld(typeof adopted === "object" ? adopted : { adopted });
      try { mutate(w); } catch (err) { check(false, `execution ${mode}: ${name}: ${err.message}`); continue; }
      const got = await decideIn(w, { mode });
      if (mode === "auto") {
        check(got.value?.source === "build",
          `execution auto: ${name} must fall back to a full build, got ${got.value?.source ?? got.error?.message}`);
        check(reason.test(got.value?.reason ?? ""), `execution auto: ${name} fell back for the wrong reason: ${got.value?.reason ?? got.error?.message}`);
      } else {
        check(got.error instanceof Refused && reason.test(got.error.message),
          `execution reuse: ${name} must fail an explicit reuse for ${reason}, got ${got.error?.message ?? got.value?.source}`);
      }
    }
  }
  // A run whose own step records show it MEANT to be covered by a witness
  // (any witness step not skipped in test or a UI shard, or a kept / handed-over
  // witness) is judged as certified, and every contradiction there is a known
  // disagreement: refused in auto AND reuse, never a quiet full rebuild.
  for (const [name, adopted, mutate, reason] of [
    ["an Ubuntu UI shard that took the witness path", true, (w) => witnessed(jobOf(w, app)), /\(evidence\) did not execute "Keep the witness \(reuse only\)" exactly once/],
    ["a macOS UI shard whose witness succeeded and smoke was skipped", true, (w) => witnessed(jobOf(w, app), { mac: true }), /\(evidence\) did not execute "Keep the witness \(reuse only\)" exactly once/],
    ["a successful witness beside an executed smoke", true, (w) => setStep(jobOf(w, app), WITNESS[2], "success"), /\(evidence\) did not execute "Keep the witness \(reuse only\)" exactly once/],
    ["a witnessed test job", true, (w) => witnessed(jobOf(w, "test")), /\(evidence\) did not execute "Keep the witness \(reuse only\)" exactly once/],
    ["an evidence job that kept a witness", true, (w) => setStep(jobOf(w, "evidence"), "Keep the witness (reuse only)", "success"), /\(evidence\) did not execute "Hand the decision to the lane only once its witness is kept" exactly once/],
    ["an evidence job that handed reuse to the lane", true, (w) => setStep(jobOf(w, "evidence"), "Hand the decision to the lane only once its witness is kept", "success"), /\(evidence\) did not execute "Keep the witness \(reuse only\)" exactly once/],
  ]) {
    for (const mode of ["auto", "reuse"]) {
      const w = reuseWorld({ adopted });
      mutate(w);
      const got = await decideIn(w, { mode });
      check(got.error instanceof Refused && reason.test(got.error.message),
        `execution ${mode}: ${name} is a certified contradiction and must be refused for ${reason}, got ${got.error?.message ?? got.value?.source}`);
    }
  }
  // Wrong evidence stays wrong under the adoption: never hidden by a rebuild.
  for (const [name, mutate, reason] of [
    ["a foreign evidence job", (w) => { jobOf(w, "evidence").run_id = 499; }, /job 899 listed under run 500 belongs to run 499/],
    ["a future-attempt evidence job", (w) => { jobOf(w, "evidence").run_attempt = 2; }, /job 899 \(evidence\) has run_attempt 2/],
    ["a digest mismatch on an adopted producer", (w) => { w.zip = payload({ dmg: "tampered dmg" }); }, /downloaded as sha256:.*but the API digest is/],
  ]) {
    for (const mode of ["auto", "reuse"]) {
      const w = reuseWorld({ adopted: true });
      mutate(w);
      const got = await decideIn(w, { mode });
      check(got.error instanceof Refused && reason.test(got.error.message),
        `execution ${mode}: ${name} must be refused for ${reason}, not ${got.value ? `treated as ${got.value.source}` : got.error?.message}`);
    }
  }

  // The shape judge itself, and agreement with the adoption generator.
  check(workflowShape(LEGACY_WORKFLOW) === "legacy", "shape: this tree's macos.yml is not judged legacy");
  check(workflowShape(adoptedText()) === ADOPTED_SHAPE, "shape: the canonical adoption is not judged adopted");
  check(workflowShape(witnessedContractText()) === WITNESSED_CONTRACT_SHAPE,
    `shape: the frozen witnessed-contract adoption is judged ${workflowShape(witnessedContractText())}`);
  check(workflowShape(eventContractText()) === EVENT_CONTRACT_SHAPE,
    `shape: the frozen event-contract adoption is judged ${workflowShape(eventContractText())}`);
  // The frozen witnessed contract, WHOLE: removing any one original check,
  // guard or capture step from it — or carrying any other generation's
  // part — is not that adoption. Each anchor must exist exactly once.
  {
    const W = WITNESSED_CONTRACT_JOB;
    const want = (needle) => { const i = W.findIndex((l) => l.includes(needle)); if (i < 0 || W.findIndex((l, k) => k > i && l.includes(needle)) >= 0) throw new Error(`stale anchor ${needle}`); return i; };
    const without = (...needles) => { const drop = new Set(needles.map(want)); return W.filter((_, i) => !drop.has(i)); };
    const capture = W.findIndex((l) => l === "      - name: Certify this job's toolchain");
    const keep = W.findIndex((l) => l === "      - name: Keep this job's toolchain certificate");
    const guardIdx = W.findIndex((l, i) => l === "        if: needs.evidence.outputs.reuse != 'true'" && W[i - 1] === "      - name: Validate release contract");
    for (const [what, lines] of [
      ["no version-format check", without("grep -Eq '^[0-9]+")],
      ["no notarize requirement", without('[ "$NOTARIZE" = true ] || exit 1')],
      ["no MARKETING_VERSION read", without("-showBuildSettings")],
      ["no MARKETING_VERSION match", without('[ "$actual" = "$RELEASE_VERSION" ]')],
      ["no publish version/main requirement", without("refs/heads/main ] || exit 1")],
      ["no readiness check", without("check-release-readiness.mjs --require-approved")],
      ["no non-macOS runner guard", without('[ "$RUNNER_OS" = macOS ]')],
      ["no notarize and no readiness", without('[ "$NOTARIZE" = true ] || exit 1', "check-release-readiness.mjs --require-approved")],
      ["no step guard on the release contract", W.filter((_, i) => i !== guardIdx)],
      ["no toolchain capture tail", W.slice(0, capture)],
      ["no kept certificate", W.slice(0, keep)],
      ["the current runner", W.map((l) => (l === EVENT_CONTRACT_CONDITIONS[2] ? CANONICAL_JOB_CONDITIONS.contract[2] : l))],
      ["the current release branch", (() => { const i = W.indexOf(EVENT_CONTRACT_BRANCH[0]); return [...W.slice(0, i), ...RELEASE_INTENT_BRANCH, ...W.slice(i + 2)]; })()],
      ["the current (fresh) contract job", [...CANONICAL_CONTRACT_JOB]],
      ["the frozen event (fresh) contract job", [...EVENT_CONTRACT_JOB]],
      ["an extra step", [...W, "      - run: true"]],
    ]) {
      check(guardIdx > 0 && capture > 0 && keep > capture && JSON.stringify(lines) !== JSON.stringify(W),
        `shape: the witnessed control "${what}" changes nothing (stale anchor)`);
      let got;
      try { got = workflowShape(withJob(witnessedContractText(), "contract", lines)); } catch (err) { got = `unbuildable (${err.message})`; }
      check(got === "non-canonical", `shape: the frozen witnessed contract with ${what} is judged ${got}, want non-canonical`);
    }
    // Comment-only edits (YAML and shell) keep every generation.
    for (const [what, text, wantShape] of [
      ["witnessed, YAML comment", () => replaceOnce(witnessedContractText(), "  contract:\n", "  contract:\n    # a new comment\n"), WITNESSED_CONTRACT_SHAPE],
      ["witnessed, shell comment", () => replaceOnce(witnessedContractText(), "          PUBLISH_RELEASE: ${{ inputs.publish_release }}\n        run: |\n          set -euo pipefail\n", "          PUBLISH_RELEASE: ${{ inputs.publish_release }}\n        run: |\n          set -euo pipefail\n          # a new shell comment\n"), WITNESSED_CONTRACT_SHAPE],
      ["event, shell comment", () => replaceOnce(eventContractText(), "          PUBLISH_RELEASE: ${{ inputs.publish_release }}\n        run: |\n          set -euo pipefail\n", "          PUBLISH_RELEASE: ${{ inputs.publish_release }}\n        run: |\n          set -euo pipefail\n          # a new shell comment\n"), EVENT_CONTRACT_SHAPE],
      ["current, shell comment", () => replaceOnce(adoptedText(), "          PUBLISH_RELEASE: ${{ inputs.publish_release }}\n        run: |\n          set -euo pipefail\n", "          PUBLISH_RELEASE: ${{ inputs.publish_release }}\n        run: |\n          set -euo pipefail\n          # a new shell comment\n"), ADOPTED_SHAPE],
    ]) {
      let got;
      try { got = workflowShape(text()); } catch (err) { got = `unbuildable (${err.message})`; }
      check(got === wantShape, `shape: a comment-only change (${what}) is judged ${got}, want ${wantShape}`);
    }
    check(Object.isFrozen(WITNESSED_CONTRACT_JOB), "shape: WITNESSED_CONTRACT_JOB is not frozen");
  }
  // Contract generations, each WHOLE. The current job is the live one; the
  // frozen event one differs from it by exactly its runner line and its
  // two-line release branch, and is frozen so the current pin cannot drag it.
  {
    const liveLines = LIVE_WORKFLOW.split("\n");
    const at = liveLines.indexOf("  contract:");
    let end = at + 1;
    while (end < liveLines.length && !/^ {2}[a-z0-9-]+:\s*$/.test(liveLines[end])) end += 1;
    const live = liveLines.slice(at, end).filter((l) => l.trim() !== "" && !l.trim().startsWith("#"));
    check(at >= 0 && JSON.stringify(live) === JSON.stringify(CANONICAL_CONTRACT_JOB),
      "shape: CANONICAL_CONTRACT_JOB drifted from the live macos.yml contract job");
    const diff = CANONICAL_CONTRACT_JOB.map((l, i) => (l === EVENT_CONTRACT_JOB[i] ? null : i)).filter((i) => i !== null);
    check(Object.isFrozen(EVENT_CONTRACT_JOB) && Object.isFrozen(EVENT_CONTRACT_CONDITIONS) && Object.isFrozen(EVENT_CONTRACT_BRANCH)
      && EVENT_CONTRACT_JOB.length === CANONICAL_CONTRACT_JOB.length && JSON.stringify(diff) === JSON.stringify([3, 14, 15])
      && EVENT_CONTRACT_JOB[3].includes("github.event_name == 'workflow_dispatch'") && !CANONICAL_CONTRACT_JOB.join("\n").includes("workflow_dispatch")
      && JSON.stringify(CANONICAL_CONTRACT_JOB.slice(14, 16)) === JSON.stringify(RELEASE_INTENT_BRANCH)
      && JSON.stringify(EVENT_CONTRACT_JOB.slice(14, 16)) === JSON.stringify(EVENT_CONTRACT_BRANCH),
    `shape: the frozen event contract is not the current one with exactly its runner and release branch swapped (lines ${diff})`);
    // Each generation alone, and every cross-generation mix, by the judge directly.
    for (const [what, text, want] of [
      ["the current adoption", () => adoptedText(), ADOPTED_SHAPE],
      ["the frozen event-contract adoption", () => eventContractText(), EVENT_CONTRACT_SHAPE],
      ["the frozen witnessed-contract adoption", () => witnessedContractText(), WITNESSED_CONTRACT_SHAPE],
      ["the event runner with the current branch", () => withEventRunsOn(adoptedText()), "non-canonical"],
      ["the current runner with the event branch", () => withEventBranch(adoptedText()), "non-canonical"],
      ["the witnessed adoption with the current runner", () => withIntentRunsOn(witnessedContractText()), "non-canonical"],
      ["the witnessed adoption with the current branch", () => withIntentBranch(witnessedContractText()), "non-canonical"],
      ["the witnessed adoption with both current lines", () => withIntentBranch(withIntentRunsOn(witnessedContractText())), "non-canonical"],
      ["the witnessed adoption with the branch twice", () => replaceOnce(witnessedContractText(), `${CONTRACT_BRANCH.event}\n`, `${CONTRACT_BRANCH.event}\n          fi\n${CONTRACT_BRANCH.event}\n`), "non-canonical"],
      ["the event contract with a witness prefix", () => withAfterSteps(eventContractText(), "contract", CANONICAL_WITNESS_STEPS), "non-canonical"],
      ["the event contract with the frozen evidence job", () => replaceOnce(eventContractText(), CANONICAL_EVIDENCE_JOB.join("\n") + "\n", WITNESSED_CONTRACT_EVIDENCE_JOB.join("\n") + "\n"), "non-canonical"],
      ["the event contract with the legacy ui-smoke triple", () => replaceOnce(eventContractText(), UI_SMOKE_TRIPLE(CANONICAL_JOB_CONDITIONS["ui-smoke"]), UI_SMOKE_TRIPLE(LEGACY_ADOPTED_UI_SMOKE_CONDITIONS)), "non-canonical"],
      ["the event contract with a fresh test", () => withoutWitness(eventContractText(), "test"), "non-canonical"],
      ["the current contract with an extra step", () => replaceOnce(adoptedText(), "\n  test:\n", "\n      - run: true\n  test:\n"), "non-canonical"],
      ["the event contract with an extra step", () => replaceOnce(eventContractText(), "\n  test:\n", "\n      - run: true\n  test:\n"), "non-canonical"],
      ["the event contract with a comment-only change", () => replaceOnce(eventContractText(), "  contract:\n", "  contract:\n    # a new comment\n"), EVENT_CONTRACT_SHAPE],
    ]) {
      let got;
      try { got = workflowShape(text()); } catch (err) { got = `unbuildable (${err.message})`; }
      check(got === want, `shape: ${what} is judged ${got}, want ${want}`);
    }
  }
  // The frozen previous adoption differs from the current one by exactly the
  // Ubuntu probe in the evidence job and the contract's witness prefix.
  {
    const at = WITNESSED_CONTRACT_EVIDENCE_JOB.indexOf(`      - name: ${EVIDENCE_UBUNTU_PROBE}`);
    const without = [...WITNESSED_CONTRACT_EVIDENCE_JOB];
    const probe = at < 0 ? [] : without.splice(at, 4);
    check(Object.isFrozen(WITNESSED_CONTRACT_EVIDENCE_JOB) && JSON.stringify(without) === JSON.stringify(CANONICAL_EVIDENCE_JOB)
      && probe.at(-1)?.includes("ci-evidence-toolchain.mjs current --profiles linux-base "),
    "shape: the frozen evidence job is not the current one plus exactly its Ubuntu linux-base probe");
  }
  // ui-smoke: the current triple, or — inside the frozen adoption only — the legacy one, each WHOLE.
  {
    let legacyShape;
    try { legacyShape = workflowShape(legacyUiSmokeText()); } catch (err) { legacyShape = `unbuildable (${err.message})`; }
    check(legacyShape === WITNESSED_CONTRACT_SHAPE, `shape: the frozen legacy ui-smoke triple is not judged the frozen adoption (got ${legacyShape})`);
    let onCurrent;
    try {
      onCurrent = workflowShape(replaceOnce(adoptedText(), UI_SMOKE_TRIPLE(CANONICAL_JOB_CONDITIONS["ui-smoke"]), UI_SMOKE_TRIPLE(LEGACY_ADOPTED_UI_SMOKE_CONDITIONS)));
    } catch (err) { onCurrent = `unbuildable (${err.message})`; }
    check(onCurrent === "non-canonical", `shape: the legacy ui-smoke triple on the CURRENT adoption is judged ${onCurrent}`);
  }
  // A mix of the two adoptions is neither.
  {
    for (const [what, text] of [
      ["the current evidence job with a witnessed contract", () => withAfterSteps(adoptedText(), "contract", CANONICAL_WITNESS_STEPS)],
      ["the frozen evidence job with a fresh contract", () => withoutWitness(witnessedContractText(), "contract")],
      ["the frozen adoption with a fresh test", () => withoutWitness(witnessedContractText(), "test")],
      ["the current adoption with a fresh test", () => withoutWitness(adoptedText(), "test")],
      ["the current adoption with a fresh ui-smoke", () => withoutWitness(adoptedText(), "ui-smoke")],
    ]) {
      let got;
      try { got = workflowShape(text()); } catch (err) { got = `unbuildable (${err.message})`; }
      check(got === "non-canonical", `shape: ${what} is judged ${got}, want non-canonical`);
    }
  }
  check(JSON.stringify(CANONICAL_JOB_CONDITIONS["ui-smoke"]) !== JSON.stringify(LEGACY_ADOPTED_UI_SMOKE_CONDITIONS)
    && Object.isFrozen(LEGACY_ADOPTED_UI_SMOKE_CONDITIONS), "shape: the legacy ui-smoke triple is not a separate frozen constant");
  for (const base of [adoptedText, eventContractText, witnessedContractText]) {
    const [needs, cond] = CANONICAL_JOB_CONDITIONS["ui-smoke"];
    const fork = " && (github.event_name != 'pull_request' || github.event.pull_request.head.repo.full_name == github.repository)";
    for (const [what, from, to] of [
      ["legacy needs with the current condition", needs, LEGACY_ADOPTED_UI_SMOKE_CONDITIONS[0]],
      ["current needs with the legacy condition", cond, LEGACY_ADOPTED_UI_SMOKE_CONDITIONS[1]],
      ["the contract term removed", cond, cond.replace(" && needs.contract.result == 'success'", "")],
      ["the fork guard removed", cond, cond.replace(fork, "")],
      ["the fork guard unparenthesized", cond, cond.replace(fork, fork.replace(" && (", " && ").replace(/\)$/, ""))],
      ["!cancelled() removed", cond, cond.replace("!cancelled() && ", "")],
      ["needs without contract", needs, "    needs: evidence"],
      ["needs with test only re-added", needs, "    needs: [test, contract, evidence]"],
    ]) {
      check(from !== to, `shape: the ui-smoke control "${what}" changes nothing (stale anchor)`);
      let text = null;
      try { text = replaceOnce(base(), `  ui-smoke:\n${needs}\n${cond}\n`, `  ui-smoke:\n${needs === from ? to : needs}\n${cond === from ? to : cond}\n`); } catch (err) { check(false, `shape: ${what}: ${err.message}`); }
      if (text !== null) check(workflowShape(text) === "non-canonical", `shape: ui-smoke with ${what} is judged ${workflowShape(text)}, want non-canonical`);
    }
  }
  // The legacy allowance is the verifier's alone: the live workflow carries the CURRENT triple.
  {
    const live = LIVE_WORKFLOW.split("\n");
    const at = live.indexOf("  ui-smoke:");
    const triple = at < 0 ? [] : live.slice(at + 1, live.indexOf("    steps:", at)).filter((l) => /^ {4}(needs|if|runs-on):/.test(l));
    check(JSON.stringify(triple) === JSON.stringify(CANONICAL_JOB_CONDITIONS["ui-smoke"]),
      `shape: the live macos.yml ui-smoke is ${JSON.stringify(triple)}, not the current triple (the legacy one is for old producers only)`);
  }
  check(workflowShape(adoptedText().replace("  screen:\n", "  screen:\n    # a new comment\n")) === ADOPTED_SHAPE
    && workflowShape(adoptedText().replace("  evidence:\n", "  evidence:\n    # a new comment\n")) === ADOPTED_SHAPE
    && workflowShape(adoptedText().replace("    steps:\n", "    steps:\n      # a new comment\n")) === ADOPTED_SHAPE
    && workflowShape(witnessedContractText().replace("  evidence:\n", "  evidence:\n    # a new comment\n")) === WITNESSED_CONTRACT_SHAPE,
  "shape: a comment-only change turned the canonical adoption off");
  check(workflowShape(adoptedText().replace("        run: node scripts/ci/ci-evidence.mjs confirm macos\n", "        run: node scripts/ci/ci-evidence.mjs confirm macos\n        continue-on-error: true\n")) === "non-canonical",
    "shape: a witness step with an added key is still judged canonical");
  check(workflowShape(LEGACY_WORKFLOW.replace("jobs:\n", "jobs:\n  evidence:\n    runs-on: ubuntu-latest\n    steps:\n      - run: true\n")) === "non-canonical",
    "shape: a hand-written evidence job is judged canonical");
  // An adopted live file, judged against a legacy reading, would mean the
  // generator vanished from a tree that still carries its output: no silent pass.
  check(VIEW !== null || workflowShape(LIVE_WORKFLOW) === "legacy",
    "shape: macos.yml carries an adoption but scripts/ci/ci-evidence-view.mjs is absent");
  if (VIEW) {
    const { view, registry, tool } = VIEW;
    const lane = registry.lanes.macos;
    const strip = (lines) => lines.filter((l) => l.trim() !== "" && !l.trim().startsWith("#"));
    // The adopted file cannot be adopted twice; its full path is the input.
    let twice = null;
    try { view.adopt(LIVE_WORKFLOW, "macos", lane, tool); } catch (error) { twice = error; }
    check(twice instanceof view.AdoptError && /already adopted/.test(twice.message),
      `shape: the generator adopted an already adopted macos.yml (${twice?.message ?? "no refusal"})`);
    check(workflowShape(LEGACY_WORKFLOW) === "legacy", "shape: the full-path text of macos.yml is not judged legacy");
    const generated = view.adopt(LEGACY_WORKFLOW, "macos", lane, tool);
    check(generated === LIVE_WORKFLOW, "shape: adopt(fullPathText(macos.yml)) does not reproduce macos.yml byte for byte");
    check(view.fullPathText(generated, "macos", lane, tool) === LEGACY_WORKFLOW,
      "shape: fullPathText(adopt(full path)) is not the full path");
    check(JSON.stringify(strip(view.evidenceJobLines("macos", lane, tool))) === JSON.stringify(CANONICAL_EVIDENCE_JOB),
      "shape: CANONICAL_EVIDENCE_JOB drifted from ci-evidence-view.mjs evidenceJobLines(\"macos\")");
    check(JSON.stringify(strip(view.witnessStepLines("macos", false))) === JSON.stringify(CANONICAL_WITNESS_STEPS),
      "shape: CANONICAL_WITNESS_STEPS drifted from ci-evidence-view.mjs witnessStepLines(\"macos\")");
    // The other pins, against the jobs of the generator's own adoption.
    const lines = generated.split("\n");
    const job = (id) => {
      const at = lines.indexOf(`  ${id}:`);
      let end = at + 1;
      while (end < lines.length && !/^ {2}[a-z0-9-]+:\s*$/.test(lines[end]) && !(lines[end] !== "" && !lines[end].startsWith(" "))) end += 1;
      return at < 0 ? [] : strip(lines.slice(at, end));
    };
    check(JSON.stringify(job("screen")) === JSON.stringify(CANONICAL_SCREEN_JOB),
      "shape: CANONICAL_SCREEN_JOB drifted from the generator's screen job");
    check(JSON.stringify(job("certify-macos")) === JSON.stringify(CANONICAL_CERTIFY_JOB),
      "shape: CANONICAL_CERTIFY_JOB drifted from the generator's certify-macos job");
    for (const [id, want] of Object.entries(CANONICAL_JOB_CONDITIONS)) {
      const b = job(id);
      const got = b.slice(0, b.indexOf("    steps:")).filter((l) => /^ {4}(needs|if|runs-on):/.test(l));
      check(JSON.stringify(got) === JSON.stringify(want),
        `shape: CANONICAL_JOB_CONDITIONS.${id} drifted from the generator's ${id} job`);
    }
    check(JSON.stringify(job("contract")) === JSON.stringify(CANONICAL_CONTRACT_JOB),
      "shape: CANONICAL_CONTRACT_JOB drifted from the generator's contract job");
    check(workflowShape(generated) === ADOPTED_SHAPE, "shape: the generator's own adoption of this tree is not judged adopted");
    check(workflowShape(LIVE_WORKFLOW) === ADOPTED_SHAPE, "shape: the live macos.yml is not judged adopted");
    generatorChecked = true;
  }
}
let generatorChecked = false;

// ── C. the dispatched gate run ──────────────────────────────────────────────

const HEAD = "c".repeat(40);
const BASE = "d".repeat(40);
const BRANCH = "release-candidate/macos-v1.4.5-777-1";

function gateWorld() {
  const run = {
    id: 9001,
    run_attempt: 1,
    head_sha: HEAD,
    head_branch: BRANCH,
    event: "workflow_dispatch",
    path: ".github/workflows/merge-gate.yml",
    workflow_id: 88,
    status: "completed",
    conclusion: "success",
    created_at: "2026-10-01T17:00:30Z",
    repository: { id: REPO_ID, full_name: REPO, fork: false },
    head_repository: { id: REPO_ID, full_name: REPO, fork: false },
  };
  const job = (name, conclusion = "success") => ({
    id: Math.floor(Math.random() * 1e9), name, run_id: 9001, head_sha: HEAD, status: "completed", conclusion,
  });
  return {
    workflow: { id: 88, path: ".github/workflows/merge-gate.yml", state: "active" },
    runs: [run],
    run,
    jobs: [job("select"), job("web / build"), job("go / test (1)"), job("macos", "skipped"), job("merge-gate")],
  };
}

function gateApi(w, state = {}) {
  return {
    async get(path) {
      const paged = /^(.*?)[?&]per_page=100&page=(\d+)$/.exec(path);
      const base = paged ? paged[1] : path;
      const page = paged ? Number(paged[2]) : 1;
      const list = (key, items) => ({ total_count: items.length, [key]: clone(items.slice((page - 1) * 100, page * 100)) });
      if (path === `/repos/${REPO}/actions/workflows/merge-gate.yml`) return clone(w.workflow);
      if (base.startsWith(`/repos/${REPO}/actions/workflows/88/runs?`)) return list("workflow_runs", w.runs);
      if (path === `/repos/${REPO}/actions/runs/9001`) return clone(state.runOverride ?? w.run);
      if (base === `/repos/${REPO}/actions/runs/9001/attempts/1/jobs`) return list("jobs", w.jobs);
      if (path === `/repos/${REPO}/git/ref/heads/main`) return { object: { sha: state.main ?? BASE } };
      if (path === `/repos/${REPO}/git/ref/heads/${BRANCH}`) return { object: { sha: state.branchTip ?? HEAD } };
      const error = new Error(`unrouted ${path}`);
      error.status = 404;
      throw error;
    },
  };
}

async function gateCases() {
  const common = { repository: REPO, repositoryId: REPO_ID, branch: BRANCH, head: HEAD };
  {
    const w = gateWorld();
    const found = await outcome(findGateRun(gateApi(w), { ...common, since: "2026-10-01T17:00:00Z" }));
    check(found.value?.id === 9001 && found.value?.attempt === 1, `gate find: the dispatched run was not found: ${found.error?.message}`);
    const ok = await outcome(judgeGateRun(gateApi(w), { ...common, runId: 9001, attempt: 1 }));
    check(ok.error === undefined, `gate verify: a green gate was refused: ${ok.error?.message}`);
  }
  for (const [name, mutate] of [
    ["a run on another head", (w) => { w.runs[0] = { ...w.run, head_sha: "e".repeat(40) }; }],
    ["a run from a fork", (w) => { w.runs[0] = { ...w.run, head_repository: { id: 3, fork: true } }; }],
    ["a stale run dispatched before this delivery", (w) => { w.runs[0] = { ...w.run, created_at: "2026-10-01T16:00:00Z" }; }],
  ]) {
    const w = gateWorld();
    mutate(w);
    const got = await outcome(findGateRun(gateApi(w), { ...common, since: "2026-10-01T17:00:00Z" }));
    check(got.value === null, `gate find: ${name} must not be taken for the candidate's gate`);
  }
  {
    const w = gateWorld();
    w.runs.push({ ...w.run, id: 9002 });
    const got = await outcome(findGateRun(gateApi(w), { ...common, since: "2026-10-01T17:00:00Z" }));
    check(got.error instanceof Refused, "gate find: two dispatched gates for one candidate must be refused");
  }
  for (const [name, mutate] of [
    ["a failed lane under a green aggregate", (w) => { w.jobs[2].conclusion = "failure"; }],
    ["a cancelled lane under a green aggregate", (w) => { w.jobs[1].conclusion = "cancelled"; }],
    ["a red aggregate", (w) => { w.jobs[4].conclusion = "failure"; w.run.conclusion = "failure"; }],
    ["a missing aggregate", (w) => { w.jobs = w.jobs.filter((j) => j.name !== "merge-gate"); }],
    ["a failed selector", (w) => { w.jobs[0].conclusion = "failure"; }],
    ["a run still in progress", (w) => { w.run.status = "in_progress"; w.run.conclusion = null; }],
    ["a newer attempt than the one found", (w) => { w.run.run_attempt = 2; }],
    ["a run on another head", (w) => { w.run.head_sha = "e".repeat(40); }],
    ["a job of another run", (w) => { w.jobs[1].run_id = 1; }],
  ]) {
    const w = gateWorld();
    mutate(w);
    const got = await outcome(judgeGateRun(gateApi(w), { ...common, runId: 9001, attempt: 1 }));
    check(got.error instanceof Refused, `gate verify: ${name} must be refused, got ${got.error?.message ?? "acceptance"}`);
  }
}

// ── D. the publication preflight ────────────────────────────────────────────

function preflightApi(state) {
  return {
    async get(path) {
      const r = this.route(path);
      if (r === undefined) { const e = new Error(path); e.status = 404; throw e; }
      return clone(r);
    },
    async getOptional(path) {
      const r = this.route(path);
      return r === undefined ? null : clone(r);
    },
    route(path) {
      if (path === `/repos/${REPO}/branches/main`) return state.branch;
      if (path === `/repos/${REPO}/actions/workflows/merge-gate.yml`) return { state: "active" };
      if (path === `/repos/${REPO}/contents/.github/workflows/merge-gate.yml?ref=main`) {
        return { content: Buffer.from(state.gateText).toString("base64") };
      }
      if (path === `/repos/${REPO}/compare/${SHA}...main`) return state.compare;
      if (path === `/repos/${REPO}/git/ref/tags/macos-v1.4.5`) return state.tag;
      return undefined;
    },
  };
}

function preflightState() {
  return {
    branch: {
      protected: true,
      protection: { required_status_checks: { contexts: ["merge-gate"], checks: [{ context: "merge-gate", app_id: 15368 }] } },
    },
    gateText: "mode:\n  options:\n    - pull-request\n    - frozen-release-metadata\n",
    compare: { status: "ahead", behind_by: 0 },
    tag: undefined,
  };
}

async function preflightCases() {
  const args = { repository: REPO, sha: SHA, ref: "refs/heads/main", releaseVersion: "1.4.5", notarize: "true" };
  const ok = await outcome(publishPreflight(preflightApi(preflightState()), args));
  check(ok.error === undefined, `publish preflight: a deliverable release was refused: ${ok.error?.message}`);
  {
    const s = preflightState();
    s.tag = { object: { type: "commit", sha: SHA } };
    const rerun = await outcome(publishPreflight(preflightApi(s), args));
    check(rerun.value?.tagExists === true, `publish preflight: a rerun whose tag is this commit was refused: ${rerun.error?.message}`);
  }
  for (const [name, mutate, override] of [
    ["a release from a branch", null, { ref: "refs/heads/feature" }],
    ["publication without notarization", null, { notarize: "false" }],
    ["a malformed version", null, { releaseVersion: "1.4" + ".5.6" }],
    ["an unprotected main", (s) => { s.branch.protected = false; }],
    ["a second required context", (s) => { s.branch.protection.required_status_checks.contexts.push("wire-vectors"); }],
    ["merge-gate bound to another app", (s) => { s.branch.protection.required_status_checks.checks[0].app_id = 1; }],
    ["a merge gate without the frozen mode", (s) => { s.gateText = "pr_number:\n"; }],
    ["a commit that is not on main", (s) => { s.compare = { status: "diverged", behind_by: 2 }; }],
    ["a tag that already names another commit", (s) => { s.tag = { object: { type: "commit", sha: "f".repeat(40) } }; }],
  ]) {
    const s = preflightState();
    if (mutate) mutate(s);
    const got = await outcome(publishPreflight(preflightApi(s), { ...args, ...(override ?? {}) }));
    check(got.error instanceof Refused, `publish preflight: ${name} must fail before the paid build`);
  }
}

// ── B/H. the frozen release-metadata candidate ──────────────────────────────

function sh(cmd, args, cwd, env = {}) {
  const out = spawnSync(cmd, args, { cwd, encoding: "utf8", env: { ...process.env, ...env } });
  if (out.status !== 0) throw new Error(`${cmd} ${args.join(" ")}: ${out.stderr}`);
  return out.stdout.trim();
}

/** A repository whose base carries the judge, and a complete candidate on it. */
function candidateRepo({ mutateCandidate } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "macos-frozen-"));
  const gitEnv = { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
  const g = (...args) => sh("git", args, dir, gitEnv);
  g("init", "-q", "-b", "main");
  for (const file of ["scripts/release/macos-evidence.mjs", "web/scripts/macos-release-candidate.mjs"]) {
    mkdirSync(dirname(join(dir, file)), { recursive: true });
    copyFileSync(join(repoRoot, file), join(dir, file));
  }
  mkdirSync(join(dir, "docs"), { recursive: true });
  writeFileSync(join(dir, "docs/unrelated.md"), "unrelated\n");
  mkdirSync(join(dir, "web"), { recursive: true });
  writeFileSync(join(dir, "web/native-releases.json"), JSON.stringify({ macos: { version: "1.4.4" } }));
  g("add", "-A");
  g("commit", "-q", "-m", "base");
  const base = g("rev-parse", "HEAD");
  for (const path of CANDIDATE_PATHS) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), `release 1.4.5 ${path}\n`);
  }
  writeFileSync(join(dir, "web/native-releases.json"), JSON.stringify({ macos: { version: "1.4.5" } }));
  if (mutateCandidate) mutateCandidate({ dir, g });
  g("add", "-A");
  g("commit", "-q", "-m", "release(mac): publish 1.4.5");
  const head = g("rev-parse", "HEAD");
  return { dir, base, head, g };
}

function frozenEnv(repo, overrides = {}) {
  return {
    GITHUB_EVENT_NAME: "workflow_dispatch",
    MODE: "frozen-release-metadata",
    GITHUB_REF: "refs/heads/release-candidate/macos-v1.4.5-777-1",
    GITHUB_REPOSITORY: REPO,
    GITHUB_SHA: repo.head,
    EXPECTED_BASE: repo.base,
    EXPECTED_HEAD: repo.head,
    ...overrides,
  };
}

function frozenApi(repo, { main, tip } = {}) {
  return {
    async get(path) {
      if (path === `/repos/${REPO}/git/ref/heads/main`) return { object: { sha: main ?? repo.base } };
      if (path.startsWith(`/repos/${REPO}/git/ref/heads/release-candidate/`)) return { object: { sha: tip ?? repo.head } };
      const e = new Error(path); e.status = 404; throw e;
    },
  };
}

async function frozenCases() {
  check(CANDIDATE_REF.test("refs/heads/release-candidate/macos-v1.4.5-777-1"), "the candidate ref pattern rejects the publisher's own branch name");
  {
    const repo = candidateRepo();
    const got = await outcome(judgeFrozenCandidate(frozenApi(repo), frozenEnv(repo), { cwd: repo.dir, judgeRoot: repo.dir }));
    check(got.error === undefined && got.value.payload.length === CANDIDATE_PATHS.length,
      `frozen: the exact one-commit metadata candidate was refused: ${got.error?.message}`);
    const cases = [
      ["a pull_request event", frozenEnv(repo, { GITHUB_EVENT_NAME: "pull_request" })],
      ["the pull-request mode", frozenEnv(repo, { MODE: "pull-request" })],
      ["a branch outside release-candidate/macos-v*", frozenEnv(repo, { GITHUB_REF: "refs/heads/main" })],
      ["a candidate branch naming another version", frozenEnv(repo, { GITHUB_REF: "refs/heads/release-candidate/macos-v1.4.6-777-1" })],
      ["a checkout other than head_sha", frozenEnv(repo, { GITHUB_SHA: repo.base })],
      ["a head input other than the checkout", frozenEnv(repo, { EXPECTED_HEAD: "e".repeat(40) })],
      ["an abbreviated base", frozenEnv(repo, { EXPECTED_BASE: repo.base.slice(0, 12) })],
    ];
    for (const [name, env] of cases) {
      const r = await outcome(judgeFrozenCandidate(frozenApi(repo), env, { cwd: repo.dir, judgeRoot: repo.dir }));
      check(r.error instanceof Refused, `frozen: ${name} must be refused`);
    }
    const moved = await outcome(judgeFrozenCandidate(frozenApi(repo, { main: "e".repeat(40) }), frozenEnv(repo), { cwd: repo.dir, judgeRoot: repo.dir }));
    check(moved.error instanceof Refused, "frozen: a base that is no longer main must be refused");
    const tip = await outcome(judgeFrozenCandidate(frozenApi(repo, { tip: "e".repeat(40) }), frozenEnv(repo), { cwd: repo.dir, judgeRoot: repo.dir }));
    check(tip.error instanceof Refused, "frozen: a candidate branch that moved must be refused");
    rmSync(repo.dir, { recursive: true, force: true });
  }
  for (const [name, mutateCandidate] of [
    ["a non-metadata file", ({ dir }) => writeFileSync(join(dir, "docs/unrelated.md"), "changed\n")],
    ["a workflow edit", ({ dir }) => { mkdirSync(join(dir, ".github/workflows"), { recursive: true }); writeFileSync(join(dir, ".github/workflows/merge-gate.yml"), "x\n"); }],
    ["an incomplete candidate", ({ dir, g }) => { g("checkout", "-q", "HEAD", "--", "web/native-releases.json"); writeFileSync(join(dir, "web/native-releases.json"), JSON.stringify({ macos: { version: "1.4.5" } })); rmSync(join(dir, CANDIDATE_PATHS.find((p) => p !== "web/native-releases.json")), { force: true }); }],
    // The rename control: the moved file lands on an ALLOWED path, so a judge
    // that saw only the destination (`git diff --name-only` with default
    // rename detection) would pass it. Its source is not allowed.
    ["a rename whose source is outside the scope", ({ dir, g }) => {
      const target = CANDIDATE_PATHS.find((p) => p.endsWith(".md")) ?? CANDIDATE_PATHS[0];
      rmSync(join(dir, target), { force: true });
      g("mv", "docs/unrelated.md", target);
    }],
  ]) {
    const repo = candidateRepo({ mutateCandidate });
    if (name.startsWith("a rename")) {
      const renamed = sh("git", ["diff", "--name-only", "-M", repo.base, repo.head], repo.dir);
      check(!renamed.split("\n").includes("docs/unrelated.md"),
        "frozen rename control is vacuous: rename detection already reports the source path");
    }
    const r = await outcome(judgeFrozenCandidate(frozenApi(repo), frozenEnv(repo), { cwd: repo.dir, judgeRoot: repo.dir }));
    check(r.error instanceof Refused, `frozen: ${name} must be refused, got ${r.error?.message ?? "acceptance"}`);
    rmSync(repo.dir, { recursive: true, force: true });
  }
  {
    // Two commits on top of base: head's parent is not base.
    const repo = candidateRepo();
    writeFileSync(join(repo.dir, "web/native-releases.json"), JSON.stringify({ macos: { version: "1.4.5" }, extra: 1 }));
    repo.g("commit", "-q", "-am", "second");
    const head = repo.g("rev-parse", "HEAD");
    const r = await outcome(judgeFrozenCandidate(frozenApi({ ...repo, head }), frozenEnv({ ...repo, head }), { cwd: repo.dir, judgeRoot: repo.dir }));
    check(r.error instanceof Refused, "frozen: an arbitrary multi-commit candidate must be refused");
    rmSync(repo.dir, { recursive: true, force: true });
  }
  {
    // A merge commit whose first parent is base.
    const repo = candidateRepo();
    repo.g("checkout", "-q", "-b", "side", repo.base);
    writeFileSync(join(repo.dir, "docs/side.md"), "side\n");
    repo.g("add", "-A");
    repo.g("commit", "-q", "-m", "side");
    repo.g("checkout", "-q", "main");
    repo.g("reset", "-q", "--hard", repo.base);
    for (const path of CANDIDATE_PATHS) {
      mkdirSync(dirname(join(repo.dir, path)), { recursive: true });
      writeFileSync(join(repo.dir, path), `release 1.4.5 ${path}\n`);
    }
    writeFileSync(join(repo.dir, "web/native-releases.json"), JSON.stringify({ macos: { version: "1.4.5" } }));
    repo.g("add", "-A");
    repo.g("commit", "-q", "-m", "meta");
    repo.g("merge", "-q", "--no-edit", "side");
    const head = repo.g("rev-parse", "HEAD");
    const r = await outcome(judgeFrozenCandidate(frozenApi({ ...repo, head }), frozenEnv({ ...repo, head }), { cwd: repo.dir, judgeRoot: repo.dir }));
    check(r.error instanceof Refused, "frozen: a merge commit must be refused");
    rmSync(repo.dir, { recursive: true, force: true });
  }
}

// ── the local API server, for the real helper and the real workflow bodies ──

/** A local stand-in for api.github.com plus a tool channel for gh/git stubs. */
async function withServer(handler, body) {
  const server = createServer((req, res) => {
    let data = "";
    req.on("data", (c) => { data += c; });
    req.on("end", () => {
      const result = handler(req.method, req.url, data);
      if (result === undefined) { res.writeHead(404); res.end("{}"); return; }
      if (Buffer.isBuffer(result)) { res.writeHead(200); res.end(result); return; }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(result));
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  try {
    return await body(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((r) => server.close(r));
  }
}

/** A PATH stub that forwards its argv to the server's tool channel. */
function toolStubs(bin, tools) {
  mkdirSync(bin, { recursive: true });
  const stub = [
    "#!/usr/bin/env node",
    "const tool = require('path').basename(process.argv[1]);",
    "fetch(process.env.STUB_SERVER + '/__tool', { method: 'POST', body: JSON.stringify({ tool, args: process.argv.slice(2) }) })",
    "  .then((r) => r.json()).then((r) => { if (r.stdout) process.stdout.write(r.stdout); if (r.stderr) process.stderr.write(r.stderr); process.exit(r.code ?? 0); })",
    "  .catch((e) => { process.stderr.write(String(e)); process.exit(97); });",
  ].join("\n");
  for (const tool of tools) {
    writeFileSync(join(bin, tool), stub, { mode: 0o755 });
  }
  writeFileSync(join(bin, "sleep"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
}

function runAsync(cmd, args, options) {
  return new Promise((resolveRun) => {
    const child = spawn(cmd, args, options);
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => { stdout += c; });
    child.stderr.on("data", (c) => { stderr += c; });
    child.on("close", (status) => resolveRun({ status, stdout, stderr }));
  });
}

/** The `run: |` body of the named step in a workflow, dedented. */
function stepBody(file, name) {
  const lines = readFileSync(join(repoRoot, file), "utf8").split("\n");
  const at = lines.findIndex((l) => l.trim() === `- name: ${name}`);
  if (at < 0) throw new Error(`${file} has no step ${name}`);
  const runAt = lines.findIndex((l, i) => i > at && /^\s+run: \|\s*$/.test(l));
  const indent = /^ */.exec(lines[runAt + 1])[0].length;
  const out = [];
  for (let i = runAt + 1; i < lines.length; i += 1) {
    const l = lines[i];
    if (l.trim() !== "" && /^ */.exec(l)[0].length < indent) break;
    out.push(l.slice(indent));
  }
  return out.join("\n");
}

// ── E. the PR-free delivery body, executed ──────────────────────────────────

async function deliverCases() {
  const body = stepBody(".github/workflows/macos-release.yml", "Deliver the frozen candidate to main");
  const scenarios = [
    { name: "a green gate on an unchanged main", expect: { code: 0, mainPushed: true } },
    { name: "main moved while the gate ran", mainMovesOnWatch: true, expect: { code: 1, mainPushed: false } },
    { name: "a lane failed under a green aggregate", laneFails: true, expect: { code: 1, mainPushed: false } },
    { name: "the gate run failed", watchFails: true, expect: { code: 1, mainPushed: false } },
    { name: "the gate was rerun after it was found", attemptChanges: true, expect: { code: 1, mainPushed: false } },
    { name: "the dispatched gate ran on another head", runHead: "e".repeat(40), expect: { code: 1, mainPushed: false } },
    { name: "main had already moved before delivery", mainStart: "f".repeat(40), expect: { code: 1, mainPushed: false, branchPushed: false } },
  ];
  for (const scenario of scenarios) {
    const scratch = mkdtempSync(join(tmpdir(), "macos-deliver-"));
    const state = { main: scenario.mainStart ?? BASE, log: [], runs: [], attempt: 1 };
    const handler = (method, url, data) => {
      if (method === "POST" && url === "/__tool") {
        const { tool, args } = JSON.parse(data);
        state.log.push(`${tool} ${args.join(" ")}`);
        if (tool === "git") {
          if (args[0] === "rev-parse") return { code: 0, stdout: `${BASE}\n` };
          if (args[0] === "push" && args[2] === `${HEAD}:refs/heads/${state.branch ?? ""}`) return { code: 0 };
          if (args[0] === "push" && args[2]?.startsWith(`${HEAD}:refs/heads/release-candidate/`)) {
            state.branch = args[2].split(":refs/heads/")[1];
            return { code: 0 };
          }
          if (args[0] === "push" && args[2] === `${HEAD}:main`) {
            if (state.main !== BASE) return { code: 1, stderr: "non-fast-forward" };
            state.main = HEAD;
            state.mainPushed = true;
            return { code: 0 };
          }
          if (args[0] === "fetch") return { code: 0 };
          if (args[0] === "merge-base") return { code: state.main === HEAD ? 0 : 1 };
          return { code: 90, stderr: `unexpected git ${args.join(" ")}` };
        }
        if (tool === "gh") {
          if (args[0] === "api" && args[1] === `repos/${REPO}/git/ref/heads/main`) return { code: 0, stdout: `${state.main}\n` };
          if (args[0] === "workflow" && args[1] === "run") {
            state.dispatch = args;
            state.runs.push({
              id: 9001, run_attempt: 1, head_sha: scenario.runHead ?? HEAD, head_branch: state.branch,
              event: "workflow_dispatch", path: ".github/workflows/merge-gate.yml", workflow_id: 88,
              status: "completed", conclusion: "success", created_at: new Date().toISOString(),
              repository: { id: REPO_ID, fork: false }, head_repository: { id: REPO_ID, fork: false },
            });
            return { code: 0 };
          }
          if (args[0] === "run" && args[1] === "watch") {
            if (scenario.mainMovesOnWatch) state.main = "9".repeat(40);
            if (scenario.attemptChanges) state.attempt = 2;
            return { code: scenario.watchFails ? 1 : 0 };
          }
          if (args[0] === "pr") { state.prCreate = true; return { code: 1, stderr: "GitHub Actions is not permitted to create or approve pull requests" }; }
          return { code: 90, stderr: `unexpected gh ${args.join(" ")}` };
        }
      }
      const path = url.replace(/^\//, "/");
      const paged = /^(.*?)[?&]per_page=100&page=(\d+)$/.exec(path);
      const base = paged ? paged[1] : path;
      if (path === `/repos/${REPO}/actions/workflows/merge-gate.yml`) return { id: 88, path: ".github/workflows/merge-gate.yml", state: "active" };
      if (base.startsWith(`/repos/${REPO}/actions/workflows/88/runs?`)) {
        const runs = Number(paged?.[2] ?? 1) > 1 ? [] : state.runs;
        return { total_count: state.runs.length, workflow_runs: runs };
      }
      if (path === `/repos/${REPO}/actions/runs/9001`) return { ...state.runs[0], run_attempt: state.attempt };
      if (base === `/repos/${REPO}/actions/runs/9001/attempts/1/jobs`) {
        const jobs = ["select", "web / build", "go / test", "merge-gate"].map((name, i) => ({
          id: i + 1, name, run_id: 9001, head_sha: HEAD, status: "completed",
          conclusion: scenario.laneFails && name === "go / test" ? "failure" : "success",
        }));
        return { total_count: jobs.length, jobs: Number(paged?.[2] ?? 1) > 1 ? [] : jobs };
      }
      return undefined;
    };
    await withServer(handler, async (server) => {
      const bin = join(scratch, "bin");
      toolStubs(bin, ["gh", "git"]);
      const script = join(scratch, "deliver.sh");
      writeFileSync(script, body);
      const result = await runAsync("bash", [script], {
        cwd: repoRoot,
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH}`,
          STUB_SERVER: server,
          GITHUB_API_URL: server,
          GH_TOKEN: "stub",
          CANDIDATE: HEAD,
          RELEASE_VERSION: "1.4.5",
          GITHUB_REPOSITORY: REPO,
          GITHUB_REPOSITORY_ID: String(REPO_ID),
          GITHUB_RUN_ID: "777",
          GITHUB_RUN_ATTEMPT: "1",
        },
      });
      const label = `deliver: ${scenario.name}`;
      const ok = scenario.expect.code === 0 ? result.status === 0 : result.status !== 0;
      check(ok, `${label}: exit ${result.status}, want ${scenario.expect.code === 0 ? 0 : "non-zero"}\n${result.stderr}`);
      check(Boolean(state.mainPushed) === scenario.expect.mainPushed,
        `${label}: main ${state.mainPushed ? "WAS" : "was not"} fast-forwarded; want ${scenario.expect.mainPushed ? "it was" : "untouched"}`);
      if (scenario.expect.branchPushed === false) {
        check(state.branch === undefined, `${label}: the candidate branch was pushed although main had already moved`);
      }
      check(!state.prCreate && !state.log.some((l) => l.startsWith("gh pr")), `${label}: delivery tried to create a pull request`);
      if (scenario.expect.code === 0) {
        check(state.branch === "release-candidate/macos-v1.4.5-777-1", `${label}: candidate branch was ${state.branch}`);
        check(JSON.stringify(state.dispatch) === JSON.stringify([
          "workflow", "run", "merge-gate.yml", "--ref", state.branch, "-f", "mode=frozen-release-metadata",
          "-f", `base_sha=${BASE}`, "-f", `head_sha=${HEAD}`]),
        `${label}: the gate was dispatched as ${JSON.stringify(state.dispatch)}`);
        const order = ["git push origin", "gh workflow run", "gh run watch", `git push origin ${HEAD}:main`]
          .map((needle) => state.log.findIndex((l) => l.startsWith(needle)));
        check(order.every((v, i) => v >= 0 && (i === 0 || v > order[i - 1])), `${label}: delivery order was ${state.log.join(" | ")}`);
      }
    });
    rmSync(scratch, { recursive: true, force: true });
  }
}

// ── H. merge-gate's collect step, executed in frozen mode ───────────────────

async function gateStepCases() {
  const body = stepBody(".github/workflows/merge-gate.yml", "Collect the pull request's cumulative file list");
  const cases = [
    { name: "the exact candidate", expect: 0 },
    { name: "a candidate with an unrelated file", mutateCandidate: ({ dir }) => writeFileSync(join(dir, "docs/unrelated.md"), "x\n"), expect: 1 },
    { name: "a base that is no longer main", main: "e".repeat(40), expect: 1 },
    { name: "an unknown dispatch mode", mode: "everything", expect: 1 },
  ];
  for (const c of cases) {
    const repo = candidateRepo({ mutateCandidate: c.mutateCandidate });
    const temp = mkdtempSync(join(tmpdir(), "macos-gate-step-"));
    const output = join(temp, "output");
    writeFileSync(output, "");
    const handler = (method, url) => {
      if (url === `/repos/${REPO}/git/ref/heads/main`) return { object: { sha: c.main ?? repo.base } };
      if (url === `/repos/${REPO}/git/ref/heads/release-candidate/macos-v1.4.5-777-1`) return { object: { sha: repo.head } };
      return undefined;
    };
    await withServer(handler, async (server) => {
      const script = join(temp, "collect.sh");
      writeFileSync(script, body);
      const result = await runAsync("bash", [script], {
        cwd: repo.dir,
        env: {
          ...process.env,
          GH_TOKEN: "stub",
          GITHUB_API_URL: server,
          GITHUB_OUTPUT: output,
          RUNNER_TEMP: temp,
          REPOSITORY: REPO,
          GITHUB_REPOSITORY: REPO,
          GITHUB_EVENT_NAME: "workflow_dispatch",
          GITHUB_REF: "refs/heads/release-candidate/macos-v1.4.5-777-1",
          GITHUB_SHA: repo.head,
          PR_NUMBER: "",
          DISPATCHED: "true",
          MODE: c.mode ?? "frozen-release-metadata",
          EXPECTED_BASE: repo.base,
          EXPECTED_HEAD: repo.head,
          CHECKED_SHA: repo.head,
        },
      });
      const label = `merge-gate frozen step: ${c.name}`;
      check(c.expect === 0 ? result.status === 0 : result.status !== 0,
        `${label}: exit ${result.status}, want ${c.expect === 0 ? 0 : "non-zero"}\n${result.stderr}`);
      if (c.expect === 0) {
        const out = readFileSync(output, "utf8");
        const count = /changed_files=(\d+)/.exec(out)?.[1];
        check(out.includes("status=ok") && Number(count) === CANDIDATE_PATHS.length,
          `${label}: the step published ${JSON.stringify(out)}`);
        const selected = spawnSync("node", [join(repoRoot, "scripts/ci/select-lanes.mjs")], {
          cwd: repoRoot,
          encoding: "utf8",
          env: { ...process.env, LANE_SELECTOR_STATUS: "ok", LANE_SELECTOR_CHANGED_FILES: count, LANE_SELECTOR_FILES: /payload=(.*)/.exec(out)?.[1] },
        });
        check(selected.status === 0 && /^web=true$/m.test(selected.stdout) && !/selecting every conditional lane/.test(selected.stderr),
          `${label}: the selector did not read the frozen payload as an ordinary change set: ${selected.stderr}`);
      }
    });
    rmSync(temp, { recursive: true, force: true });
    rmSync(repo.dir, { recursive: true, force: true });
  }
}

// ── F. the mounted-package verifier ─────────────────────────────────────────

/** A plist with real types: booleans, strings, integers, arrays, dicts and,
 *  for the malformed controls, dates. Never a string standing in for an array. */
function plistXml(root) {
  const value = (v) => {
    if (v === true) return "<true/>";
    if (v === false) return "<false/>";
    if (Number.isInteger(v)) return `<integer>${v}</integer>`;
    if (Array.isArray(v)) return `<array>${v.map(value).join("")}</array>`;
    if (v && typeof v === "object" && "date" in v) return `<date>${v.date}</date>`;
    if (v && typeof v === "object") return `<dict>${Object.entries(v).map(([k, x]) => `<key>${k}</key>${value(x)}`).join("")}</dict>`;
    return `<string>${v}</string>`;
  };
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0">${value(root)}</plist>\n`;
}

/**
 * The direct product's ACTUAL signed entitlements, typed exactly as a real
 * `main` signed-build printed them (run 36883327742, job 110440631775; the
 * verbatim excerpt is kept with this revision's evidence). The valid world
 * signs with these; every entitlement control below changes one thing.
 */
const APP_ENTS = () => ({
  "com.apple.application-identifier": "7PVYUG4YQS.com.relayium.mac",
  "com.apple.developer.associated-domains": ["applinks:relayium.com"],
  "com.apple.developer.team-identifier": "7PVYUG4YQS",
  "com.apple.security.app-sandbox": true,
  "com.apple.security.application-groups": ["7PVYUG4YQS.com.relayium.shared"],
  "com.apple.security.files.downloads.read-write": true,
  "com.apple.security.files.user-selected.read-write": true,
  "com.apple.security.network.client": true,
  "com.apple.security.network.server": true,
  "com.apple.security.temporary-exception.mach-lookup.global-name": ["com.relayium.mac-spks", "com.relayium.mac-spki"],
  "keychain-access-groups": ["7PVYUG4YQS.com.relayium.shared"],
});
const APPEX_ENTS = () => ({
  "com.apple.application-identifier": "7PVYUG4YQS.com.relayium.mac.Share",
  "com.apple.developer.team-identifier": "7PVYUG4YQS",
  "com.apple.security.app-sandbox": true,
  "com.apple.security.application-groups": ["7PVYUG4YQS.com.relayium.shared"],
});
const DEV_ID = (id) => [
  `Identifier=${id}`, "CodeDirectory v=20500 size=1 flags=0x10000(runtime) hashes=1+7 location=embedded",
  "Authority=Developer ID Application: Relayium LLC (7PVYUG4YQS)", "Authority=Developer ID Certification Authority",
  "Authority=Apple Root CA", "Timestamp=Oct 1, 2026 at 10:00:00", "TeamIdentifier=7PVYUG4YQS",
].join("\n");

function verifierWorld() {
  return {
    appInfo: {
      CFBundleIdentifier: "com.relayium.mac", CFBundleExecutable: "Relayium", CFBundleShortVersionString: "1.4.5",
      CFBundleVersion: "42", SUEnableInstallerLauncherService: true,
      SUFeedURL: "https://relayium.com/apps/macos/appcast.xml", SUPublicEDKey: "abc=",
    },
    appexInfo: { CFBundleIdentifier: "com.relayium.mac.Share", CFBundleExecutable: "RelayiumShare", CFBundleShortVersionString: "1.4.5", CFBundleVersion: "42" },
    archs: { app: "arm64", appex: "arm64" },
    sparkle: true,
    privacy: true,
    signatures: {
      "Relayium.dmg": { verify: 0, details: DEV_ID("Relayium") },
      "Relayium.app": { verify: 0, details: DEV_ID("com.relayium.mac"), entitlements: APP_ENTS() },
      "RelayiumShare.appex": { verify: 0, details: DEV_ID("com.relayium.mac.Share"), entitlements: APPEX_ENTS() },
    },
    tool: "generate_appcast bytes",
    provenance: {},
  };
}

function verifierStubs(bin) {
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, "plutil"), `#!/usr/bin/env python3
import plistlib, sys
a = sys.argv[1:]
def load(path):
    data = sys.stdin.buffer.read() if path == "-" else open(path, "rb").read()
    return plistlib.loads(data)
if a[0] == "-lint":
    load(a[1]); print(a[1] + ": OK"); sys.exit(0)
if a[0] == "-convert" and a[1] == "json":
    import json
    try:
        sys.stdout.write(json.dumps(load(a[-1]))); sys.exit(0)
    except Exception as e:
        sys.stderr.write("invalid object in plist for destination format: %s" % e); sys.exit(1)
if a[0] == "-convert":
    sys.stdout.buffer.write(plistlib.dumps(load(a[-1]), fmt=plistlib.FMT_XML)); sys.exit(0)
if a[0] == "-extract":
    v = load(a[-1])
    for part in a[1].split("."):
        try:
            v = v[int(part)] if isinstance(v, list) else v[part]
        except Exception:
            sys.exit(1)
    if isinstance(v, bool): print("true" if v else "false")
    elif isinstance(v, (list, dict)): print(len(v))
    else: print(v)
    sys.exit(0)
sys.exit(2)
`, { mode: 0o755 });
  writeFileSync(join(bin, "codesign"), `#!/usr/bin/env node
const fs = require("fs"), path = require("path");
const a = process.argv.slice(2), target = a[a.length - 1];
const db = JSON.parse(fs.readFileSync(process.env.FAKE_CODESIGN, "utf8"))[path.basename(target)];
if (!db) process.exit(1);
if (a.includes("--verify")) process.exit(db.verify);
if (a.includes("--entitlements")) { process.stdout.write(db.entitlements ?? ""); process.exit(0); }
process.stderr.write(db.details + "\\n"); process.exit(0);
`, { mode: 0o755 });
  writeFileSync(join(bin, "lipo"), `#!/bin/sh
[ "$1" = -archs ] || exit 2
sed -n 's/^ARCHS=//p' "$2" | grep . || exit 1
`, { mode: 0o755 });
  writeFileSync(join(bin, "hdiutil"), `#!/bin/sh
case "$1" in
  attach) mount=""; while [ $# -gt 0 ]; do [ "$1" = -mountpoint ] && mount="$2"; shift; done; cp -R "$FAKE_VOLUME/." "$mount/" ;;
  detach) exit 0 ;;
  *) exit 2 ;;
esac
`, { mode: 0o755 });
}

function verifierFixture(w, scratch) {
  const volume = join(scratch, "volume");
  const app = join(volume, "Relayium.app/Contents");
  const appex = join(app, "PlugIns/RelayiumShare.appex/Contents");
  for (const d of [join(app, "MacOS"), join(app, "Resources"), join(appex, "MacOS"), join(appex, "Resources")]) mkdirSync(d, { recursive: true });
  writeFileSync(join(app, "Info.plist"), plistXml(w.appInfo));
  writeFileSync(join(appex, "Info.plist"), plistXml(w.appexInfo));
  writeFileSync(join(app, "MacOS/Relayium"), `ARCHS=${w.archs.app}\n`);
  writeFileSync(join(appex, "MacOS/RelayiumShare"), `ARCHS=${w.archs.appex}\n`);
  if (w.sparkle) mkdirSync(join(app, "Frameworks/Sparkle.framework"), { recursive: true });
  if (w.privacy) copyFileSync(join(repoRoot, "apps/mac/Relayium/PrivacyInfo.xcprivacy"), join(app, "Resources/PrivacyInfo.xcprivacy"));
  copyFileSync(join(repoRoot, "apps/mac/RelayiumShare/PrivacyInfo.xcprivacy"), join(appex, "Resources/PrivacyInfo.xcprivacy"));
  const dmg = join(scratch, "Relayium.dmg");
  writeFileSync(dmg, "dmg bytes");
  const tool = join(scratch, "generate_appcast");
  writeFileSync(tool, w.tool);
  const provenance = join(scratch, "provenance.json");
  writeFileSync(provenance, JSON.stringify({
    dmgSha256: sha256(Buffer.from("dmg bytes")), generateAppcastSha256: sha256(Buffer.from("generate_appcast bytes")),
    channel: "direct", arch: "arm64", version: "1.4.5", build: "42", shareExtensionVersion: "1.4.5", shareExtensionBuild: "42",
    ...w.provenance,
  }));
  const codesignDb = join(scratch, "codesign.json");
  // Entitlements are written as a real XML plist from their typed value;
  // a string in `entitlementsXml` is used verbatim, for the malformed controls.
  const signatures = Object.fromEntries(Object.entries(w.signatures).map(([k, v]) => [k, {
    ...v,
    entitlements: v.entitlementsXml ?? (v.entitlements === undefined ? undefined : plistXml(v.entitlements)),
  }]));
  writeFileSync(codesignDb, JSON.stringify(signatures));
  return { volume, dmg, tool, provenance, codesignDb };
}

function verifierCases() {
  const hasPython = spawnSync("python3", ["-c", "import plistlib"]).status === 0;
  const hasJq = spawnSync("jq", ["--version"]).status === 0;
  check(hasPython && hasJq, "the package-verifier controls need python3 (plistlib) and jq, and did not run");
  if (!hasPython || !hasJq) return;
  const scenarios = [
    ["the direct Developer ID package", () => {}, true],
    ["a DMG whose hash is not the provenance's", (w) => { w.provenance.dmgSha256 = "0".repeat(64); }, /the DMG does not hash to provenance\.dmgSha256/],
    ["a tampered generate_appcast", (w) => { w.tool = "evil"; }, /generate_appcast does not hash to provenance\.generateAppcastSha256/],
    ["an app signature that does not verify", (w) => { w.signatures["Relayium.app"].verify = 1; }, /deep signature does not verify/],
    ["an unsigned DMG", (w) => { delete w.signatures["Relayium.dmg"]; }, /signature does not verify: .*Relayium\.dmg/],
    ["an Apple Distribution (store) signature", (w) => { w.signatures["Relayium.app"].details = w.signatures["Relayium.app"].details.replace("Developer ID Application: Relayium LLC", "Apple Distribution: Relayium LLC"); }, /not signed with a Developer ID Application identity of team 7PVYUG4YQS/],
    ["another team", (w) => { w.signatures["RelayiumShare.appex"].details = w.signatures["RelayiumShare.appex"].details.replace(/7PVYUG4YQS/g, "ABCDE12345"); }, /not signed with a Developer ID Application identity of team 7PVYUG4YQS: .*RelayiumShare\.appex/],
    ["no secure timestamp", (w) => { w.signatures["Relayium.app"].details = w.signatures["Relayium.app"].details.replace(/^Timestamp=.*$/m, ""); }, /no secure timestamp: .*Relayium\.app/],
    ["no Hardened Runtime", (w) => { w.signatures["Relayium.app"].details = w.signatures["Relayium.app"].details.replace("(runtime)", "(none)"); }, /app lacks the Hardened Runtime/],
    ["the App Store product (no Sparkle) passed off as direct", (w) => { w.sparkle = false; delete w.appInfo.SUFeedURL; }, /no Sparkle: this is not the direct product/],
    ["a universal app", (w) => { w.archs.app = "x86_64 arm64"; }, /MacOS\/Relayium is not Apple Silicon only \(architectures: x86_64 arm64\)/],
    ["an Intel Share extension", (w) => { w.archs.appex = "x86_64"; }, /RelayiumShare is not Apple Silicon only \(architectures: x86_64\)/],
    ["an app version that is not the provenance's", (w) => { w.appInfo.CFBundleShortVersionString = "1.4.4"; }, /app version is not provenance 1\.4\.5/],
    ["an app build that is not the provenance's", (w) => { w.appInfo.CFBundleVersion = "41"; }, /app build is not provenance 42/],
    ["a Share extension version mismatch", (w) => { w.appexInfo.CFBundleShortVersionString = "1.4.4"; }, /Share extension version is not 1\.4\.5/],
    ["a Share extension build mismatch", (w) => { w.appexInfo.CFBundleVersion = "41"; }, /Share extension build is not 42/],
    ["another bundle identifier", (w) => { w.appInfo.CFBundleIdentifier = "com.relayium.mac.dev"; }, /app bundle identifier is not com\.relayium\.mac/],
    // Entitlements: typed and exact. The first is the root reproduction — every
    // required key PRESENT, every value false or a bare string — which a
    // presence grep accepted.
    ["the root repro: every required key present with false/string values", (w) => {
      const e = w.signatures["Relayium.app"].entitlements;
      e["com.apple.security.app-sandbox"] = false;
      e["com.apple.security.application-groups"] = false;
      e["keychain-access-groups"] = "7PVYUG4YQS.com.relayium.shared";
      e["com.apple.developer.associated-domains"] = "applinks:relayium.com";
      e["com.apple.security.temporary-exception.mach-lookup.global-name"] = "com.relayium.mac-spks com.relayium.mac-spki";
    }, /app entitlements: .*com\.apple\.security\.app-sandbox is false, want true/],
    ["an app sandbox that is false", (w) => { w.signatures["Relayium.app"].entitlements["com.apple.security.app-sandbox"] = false; }, /app entitlements: com\.apple\.security\.app-sandbox is false, want true/],
    ["a Share extension sandbox that is false", (w) => { w.signatures["RelayiumShare.appex"].entitlements["com.apple.security.app-sandbox"] = false; }, /Share extension entitlements: com\.apple\.security\.app-sandbox is false, want true/],
    ["a sandbox written as a string", (w) => { w.signatures["Relayium.app"].entitlements["com.apple.security.app-sandbox"] = "true"; }, /app-sandbox is a string, want boolean/],
    ["an App Group written as a string, not an array", (w) => { w.signatures["Relayium.app"].entitlements["com.apple.security.application-groups"] = "7PVYUG4YQS.com.relayium.shared"; }, /application-groups is a string, want array/],
    ["a keychain group written as a string, not an array", (w) => { w.signatures["Relayium.app"].entitlements["keychain-access-groups"] = "7PVYUG4YQS.com.relayium.shared"; }, /keychain-access-groups is a string, want array/],
    ["an associated domain written as a string", (w) => { w.signatures["Relayium.app"].entitlements["com.apple.developer.associated-domains"] = "applinks:relayium.com"; }, /associated-domains is a string, want array/],
    ["the Sparkle Mach names joined in one string", (w) => { w.signatures["Relayium.app"].entitlements["com.apple.security.temporary-exception.mach-lookup.global-name"] = "com.relayium.mac-spks com.relayium.mac-spki"; }, /mach-lookup\.global-name is a string, want array/],
    ["a foreign App Group", (w) => { w.signatures["Relayium.app"].entitlements["com.apple.security.application-groups"] = ["group.com.relayium.app"]; }, /application-groups is \["group\.com\.relayium\.app"\]/],
    ["an extra App Group member", (w) => { w.signatures["RelayiumShare.appex"].entitlements["com.apple.security.application-groups"].push("7PVYUG4YQS.com.evil"); }, /Share extension entitlements: com\.apple\.security\.application-groups is \[.*com\.evil/],
    ["a duplicated App Group member", (w) => { w.signatures["Relayium.app"].entitlements["com.apple.security.application-groups"].push("7PVYUG4YQS.com.relayium.shared"); }, /application-groups is \["7PVYUG4YQS\.com\.relayium\.shared","7PVYUG4YQS\.com\.relayium\.shared"\]/],
    ["an empty App Group array", (w) => { w.signatures["Relayium.app"].entitlements["com.apple.security.application-groups"] = []; }, /application-groups is \[\], want/],
    ["an unexpanded keychain prefix", (w) => { w.signatures["Relayium.app"].entitlements["keychain-access-groups"] = ["$(AppIdentifierPrefix)com.relayium.shared"]; }, /keychain-access-groups is \["\$\(AppIdentifierPrefix\)com\.relayium\.shared"\]/],
    ["a foreign associated domain", (w) => { w.signatures["Relayium.app"].entitlements["com.apple.developer.associated-domains"].push("applinks:evil.example"); }, /associated-domains is \[.*evil\.example/],
    ["a Sparkle Mach name for another bundle", (w) => { w.signatures["Relayium.app"].entitlements["com.apple.security.temporary-exception.mach-lookup.global-name"] = ["com.evil-spks", "com.relayium.mac-spki"]; }, /mach-lookup\.global-name is \["com\.evil-spks"/],
    ["a missing Sparkle installer channel (App Store-shaped)", (w) => { delete w.signatures["Relayium.app"].entitlements["com.apple.security.temporary-exception.mach-lookup.global-name"]; }, /app entitlements: lacks entitlement com\.apple\.security\.temporary-exception\.mach-lookup\.global-name/],
    ["a network client entitlement that is false", (w) => { w.signatures["Relayium.app"].entitlements["com.apple.security.network.client"] = false; }, /network\.client is false, want true/],
    ["a missing associated domain", (w) => { delete w.signatures["Relayium.app"].entitlements["com.apple.developer.associated-domains"]; }, /lacks entitlement com\.apple\.developer\.associated-domains/],
    ["another application identifier", (w) => { w.signatures["Relayium.app"].entitlements["com.apple.application-identifier"] = "7PVYUG4YQS.com.relayium.mac.dev"; }, /application-identifier is "7PVYUG4YQS\.com\.relayium\.mac\.dev"/],
    ["a debuggable app (get-task-allow true)", (w) => { w.signatures["Relayium.app"].entitlements["com.apple.security.get-task-allow"] = true; }, /app entitlements: carries unpermitted entitlement com\.apple\.security\.get-task-allow/],
    ["an unpermitted key even when false", (w) => { w.signatures["Relayium.app"].entitlements["com.apple.security.get-task-allow"] = false; }, /carries unpermitted entitlement com\.apple\.security\.get-task-allow/],
    ["the App Store's Sign in with Apple on the direct app", (w) => { w.signatures["Relayium.app"].entitlements["com.apple.developer.applesignin"] = ["Default"]; }, /carries unpermitted entitlement com\.apple\.developer\.applesignin/],
    ["a sandbox-escaping privilege on the app", (w) => { w.signatures["Relayium.app"].entitlements["com.apple.security.cs.disable-library-validation"] = true; }, /carries unpermitted entitlement com\.apple\.security\.cs\.disable-library-validation/],
    ["a Share extension with network access", (w) => { w.signatures["RelayiumShare.appex"].entitlements["com.apple.security.network.client"] = true; }, /Share extension entitlements: carries unpermitted entitlement com\.apple\.security\.network\.client/],
    ["a Share extension with a keychain group", (w) => { w.signatures["RelayiumShare.appex"].entitlements["keychain-access-groups"] = ["7PVYUG4YQS.com.relayium.shared"]; }, /Share extension entitlements: carries unpermitted entitlement keychain-access-groups/],
    ["a Share extension with the app's file access", (w) => { w.signatures["RelayiumShare.appex"].entitlements["com.apple.security.files.user-selected.read-write"] = true; }, /Share extension entitlements: carries unpermitted entitlement com\.apple\.security\.files\.user-selected\.read-write/],
    ["a Share extension with no App Group", (w) => { delete w.signatures["RelayiumShare.appex"].entitlements["com.apple.security.application-groups"]; }, /Share extension entitlements: lacks entitlement com\.apple\.security\.application-groups/],
    ["entitlements that are an array, not a dictionary", (w) => { w.signatures["Relayium.app"].entitlements = ["com.apple.security.app-sandbox"]; }, /app entitlements: the entitlements are a array, not a dictionary/],
    ["entitlements carrying a date value", (w) => { w.signatures["Relayium.app"].entitlements["com.apple.security.app-sandbox"] = { date: "2026-10-01T00:00:00Z" }; }, /app entitlements are not a plain typed plist/],
    ["entitlements that are not a plist", (w) => { w.signatures["Relayium.app"].entitlementsXml = "<plist><dict><key>broken"; }, /app entitlements are not a plain typed plist/],
    ["no entitlements at all on the extension", (w) => { w.signatures["RelayiumShare.appex"].entitlementsXml = ""; }, /Share extension entitlements are not a plain typed plist/],
    ["a missing privacy manifest", (w) => { w.privacy = false; }, /privacy manifest missing from the built product/],
    ["a provenance claiming the App Store channel", (w) => { w.provenance.channel = "app-store"; }, /provenance\.channel is not direct/],
  ];
  for (const [name, mutate, outcome] of scenarios) {
    const valid = outcome === true;
    const scratch = mkdtempSync(join(tmpdir(), "macos-verify-app-"));
    const w = verifierWorld();
    mutate(w);
    const f = verifierFixture(w, scratch);
    const bin = join(scratch, "bin");
    verifierStubs(bin);
    const result = spawnSync("bash", [join(repoRoot, "scripts/release/macos-evidence-verify-app.sh"), f.dmg, f.provenance, f.tool, join(scratch, "mount")], {
      encoding: "utf8",
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, FAKE_CODESIGN: f.codesignDb, FAKE_VOLUME: f.volume },
    });
    check(valid ? result.status === 0 : result.status !== 0,
      `verify-app: ${name}: exit ${result.status}, want ${valid ? 0 : "non-zero"}\n${result.stderr}${result.stdout}`);
    if (outcome instanceof RegExp) {
      check(outcome.test(`${result.stderr}${result.stdout}`), `verify-app: ${name} was not refused for ${outcome}: ${result.stderr.trim()}`);
    }
    if (process.env.MACOS_EVIDENCE_VERBOSE && !valid) process.stderr.write(`  verify-app refused (${name}): ${result.stderr.trim().split("\n").pop()}\n`);
    rmSync(scratch, { recursive: true, force: true });
  }
}

// ── G. the release contract on the notarization runner ──────────────────────

function contractCases() {
  const scenarios = [
    ["a validation-only dispatch", {}, true],
    ["a notarized release candidate", { RELEASE_VERSION: "1.4.5", NOTARIZE: "true" }, true],
    ["a publication from main", { RELEASE_VERSION: "1.4.5", NOTARIZE: "true", PUBLISH_RELEASE: "true", GITHUB_REF: "refs/heads/main" }, true],
    ["a publication from a branch", { RELEASE_VERSION: "1.4.5", NOTARIZE: "true", PUBLISH_RELEASE: "true", GITHUB_REF: "refs/heads/x" }],
    ["a publication without notarization", { RELEASE_VERSION: "1.4.5", NOTARIZE: "false", PUBLISH_RELEASE: "true", GITHUB_REF: "refs/heads/main" }],
    ["a publication with no version", { PUBLISH_RELEASE: "true", GITHUB_REF: "refs/heads/main" }],
    ["a malformed version", { RELEASE_VERSION: "1.4.5-beta", NOTARIZE: "true" }],
    ["a version the project does not carry", { RELEASE_VERSION: "1.4.6", NOTARIZE: "true" }],
    ["a package build the project does not carry", { RELEASE_VERSION: "1.4.5", NOTARIZE: "true" }, false, { build: "41" }],
    ["a package version the project does not carry", { RELEASE_VERSION: "1.4.5", NOTARIZE: "true" }, false, { version: "1.4.4" }],
    ["readiness not approved", { RELEASE_VERSION: "1.4.5", NOTARIZE: "true", PUBLISH_RELEASE: "true", GITHUB_REF: "refs/heads/main", READY: "1" }],
  ];
  for (const [name, env, valid, provenancePatch] of scenarios) {
    const scratch = mkdtempSync(join(tmpdir(), "macos-contract-"));
    const bin = join(scratch, "bin");
    mkdirSync(bin);
    writeFileSync(join(bin, "xcodebuild"), "#!/bin/sh\nprintf '    MARKETING_VERSION = 1.4.5\\n    CURRENT_PROJECT_VERSION = 42\\n'\n", { mode: 0o755 });
    mkdirSync(join(scratch, "apps/mac/scripts"), { recursive: true });
    writeFileSync(join(scratch, "apps/mac/scripts/check-release-readiness.mjs"), "process.exit(Number(process.env.READY ?? 0));\n");
    const provenance = join(scratch, "provenance.json");
    writeFileSync(provenance, JSON.stringify({ version: "1.4.5", build: "42", ...(provenancePatch ?? {}) }));
    const result = spawnSync("bash", [join(repoRoot, "scripts/release/macos-evidence-release-contract.sh"), provenance], {
      cwd: scratch,
      encoding: "utf8",
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, RELEASE_VERSION: "", NOTARIZE: "false", PUBLISH_RELEASE: "false", GITHUB_REF: "refs/heads/main", ...env },
    });
    check(valid ? result.status === 0 : result.status !== 0,
      `release contract: ${name}: exit ${result.status}, want ${valid ? 0 : "non-zero"}\n${result.stderr}`);
    rmSync(scratch, { recursive: true, force: true });
  }
}


// ── certified coverage (E with F's full proof) ──────────────────────────────

/**
 * The AUTHENTIC 191d main push run 37313600321 attempt 1 (its jobs, run record,
 * artifact listing and the retained witness ZIP, byte-identical to the API's
 * digest), under scripts/test/fixtures/macos-certified/. The source proof's
 * own API records (pulls, merge-gate listing, commits, trees, certificates)
 * are NOT captured there, so the full positive stops where F's judge asks for
 * the first of them: absent is `Unavailable` (auto builds), never a pass.
 */
const CERTIFIED_DIR = join(repoRoot, "scripts/test/fixtures/macos-certified");
const MAIN_SHA = "191d9c845aae736e731b5fd0c9db9c49f5e9ef27";
function certifiedWorld() {
  const read = (name) => readFileSync(join(CERTIFIED_DIR, name));
  return {
    run: JSON.parse(read("main-run-37313600321.json")),
    jobs: JSON.parse(read("main-jobs-37313600321-attempt-1.json")).jobs,
    artifacts: JSON.parse(read("main-artifacts-37313600321.json")).artifacts,
    zip: read("main-witness-37313600321.zip"),
  };
}
// HERMETIC: the signed commit is the authentic raw 191d commit object, checked
// here against its own SHA-1 object id (so it cannot be a forged stand-in), and
// served for exactly the two reads that precede F's first source-API call
// (`headFacts`). It does not depend on the checkout's history, which a shallow
// hosted clone after later commits would not hold. Any other read is the
// typed absence a real checkout without the object reports.
const RAW_COMMIT = readFileSync(join(CERTIFIED_DIR, `commit-${MAIN_SHA}.raw`));
const rawCommitId = createHash("sha1").update(Buffer.concat([Buffer.from(`commit ${RAW_COMMIT.length}\0`), RAW_COMMIT])).digest("hex");
const GIT_OBJECTS = JSON.parse(readFileSync(join(CERTIFIED_DIR, "git-objects-191d.json"), "utf8"));
function gitObject(id, type) {
  const entry = GIT_OBJECTS[id];
  if (entry?.type !== type) throw new Error(`no authentic ${type} ${id} in the fixture`);
  const body = Buffer.from(entry.base64, "base64");
  const got = createHash("sha1").update(Buffer.concat([Buffer.from(`${type} ${body.length}\0`), body])).digest("hex");
  if (got !== id) throw new Error(`fixture ${type} ${id} hashes to ${got}`);
  return body;
}
const localGit = (args) => {
  if (rawCommitId !== MAIN_SHA) throw new Error(`the raw commit fixture hashes to ${rawCommitId}, not ${MAIN_SHA}`);
  const key = JSON.stringify(args);
  if (key === JSON.stringify(["show", "-s", "--format=%H%n%T", MAIN_SHA])) {
    return Buffer.from(`${MAIN_SHA}\n${/^tree ([0-9a-f]{40})$/m.exec(RAW_COMMIT.toString("utf8"))[1]}\n`);
  }
  if (key === JSON.stringify(["cat-file", "commit", MAIN_SHA])) return Buffer.from(RAW_COMMIT);
  // `show <sha>:<path>`: walked from the commit's tree through authentic raw
  // tree objects to the blob, every object re-hashed to its own id first.
  if (args.length === 2 && args[0] === "show" && args[1].startsWith(`${MAIN_SHA}:`)) {
    let id = /^tree ([0-9a-f]{40})$/m.exec(RAW_COMMIT.toString("utf8"))[1];
    for (const part of args[1].slice(MAIN_SHA.length + 1).split("/")) {
      const tree = gitObject(id, "tree");
      id = null;
      for (let at = 0; at < tree.length;) {
        const nul = tree.indexOf(0, at);
        const name = tree.subarray(tree.indexOf(0x20, at) + 1, nul).toString("utf8");
        if (name === part) { id = tree.subarray(nul + 1, nul + 21).toString("hex"); break; }
        at = nul + 21;
      }
      if (id === null || GIT_OBJECTS[id] === undefined) break;
    }
    if (id !== null && GIT_OBJECTS[id]?.type === "blob") return gitObject(id, "blob");
  }
  throw new CertifiedUnavailable(`git ${args.slice(0, 2).join(" ")} could not read the signed commit locally`);
};
function certifiedApi(w, { calls = [] } = {}) {
  const missing = (path) => Object.assign(new Error(`404 ${path}`), { status: 404 });
  return {
    async get(path) {
      calls.push(path);
      const bare = path.replace(/[?&]per_page=100&page=\d+$/, "");
      if (bare === `/repos/${REPO}/actions/runs/${w.run.id}/artifacts`) {
        return { total_count: w.artifacts.length, artifacts: clone(w.artifacts) };
      }
      const art = /^\/repos\/[^/]+\/[^/]+\/actions\/artifacts\/(\d+)$/.exec(bare);
      if (art) {
        const hit = w.artifacts.find((a) => a.id === Number(art[1]));
        if (hit) return clone(hit);
      }
      throw missing(path);
    },
    async download(path) {
      calls.push(path);
      const witness = w.artifacts.find((a) => /witness/.test(a.name));
      if (witness && path === `/repos/${REPO}/actions/artifacts/${witness.id}/zip`) return Buffer.from(w.zip);
      throw missing(path);
    },
  };
}
const rosterArgs = (w) => ({ runId: w.run.id, sha: MAIN_SHA, latestAttempt: w.run.run_attempt, shape: ADOPTED_SHAPE });
const byName = (w, name) => w.jobs.find((j) => (name.includes("(") ? j.name.startsWith(name) : j.name === name));
async function certifiedOutcome(w, opts = {}) {
  const coverage = coverageOf(w.jobs, ADOPTED_SHAPE);
  const roster = judgeProducerRoster(w.jobs, { ...rosterArgs(w), coverage });
  const ids = ["contract", "test", "ui-smoke/app-shell", "ui-smoke/device-inbox", "signed-build"];
  return outcome(judgeCertifiedCoverage(certifiedApi(w, opts), {
    repository: REPO, repositoryId: REPO_ID, sha: MAIN_SHA, run: w.run, now: opts.now ?? Date.parse("2026-10-05T16:30:00Z"),
    rosterJobs: ids.map((id, i) => ({ id, job: roster.jobs[i] })), evidenceJob: roster.auxiliaryJobs[2],
    certifyJob: roster.auxiliaryJobs[1], sourceGit: localGit,
  }));
}

/**
 * The publisher checkout depth, on REAL git: a release commit and its first
 * parent in a temporary repository, cloned at depth 1 and at depth 2 through
 * `file://` (so `--depth` is honoured). The certified source derivation needs
 * `git diff-tree <parent> <sha>`: depth 1 lacks the parent object and reads as
 * the typed absence (auto would rebuild); depth 2 derives the change set.
 */
function depthCases() {
  const scratch = mkdtempSync(join(tmpdir(), "macos-evidence-depth-"));
  try {
    const origin = join(scratch, "origin");
    const g = (cwd, ...args) => {
      const r = spawnSync("git", args, { cwd, encoding: "utf8", env: { ...isolatedGitEnvironment(), GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: "1",
        GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid" } });
      if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
      return r.stdout.trim();
    };
    mkdirSync(origin);
    g(origin, "init", "-q", "-b", "main");
    writeFileSync(join(origin, "a.txt"), "base\n");
    g(origin, "add", "a.txt"); g(origin, "commit", "-q", "-m", "base");
    const base = g(origin, "rev-parse", "HEAD");
    writeFileSync(join(origin, "a.txt"), "candidate\n");
    g(origin, "commit", "-q", "-am", "candidate");
    const sha = g(origin, "rev-parse", "HEAD");
    for (const depth of [1, 2]) {
      const clone = join(scratch, `depth-${depth}`);
      g(scratch, "clone", "-q", `--depth=${depth}`, `file://${origin}`, clone);
      const runGit = (args) => {
        const r = spawnSync("git", args, { cwd: clone, encoding: "buffer", env: { ...isolatedGitEnvironment(), GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } });
        if (r.status !== 0) throw new CertifiedUnavailable(`git ${args.slice(0, 2).join(" ")} could not read the signed commit locally`);
        return r.stdout;
      };
      let got;
      try { got = pinnedSourceTree(runGit, sha).git(["diff-tree", "-r", "--name-status", base, "HEAD"]).toString("utf8"); } catch (e) { got = e; }
      if (depth === 1) {
        check(got instanceof CertifiedUnavailable, `depth: a depth-1 publisher checkout must lack the parent (typed absence), got ${got?.message ?? JSON.stringify(got)}`);
      } else {
        check(typeof got === "string" && /^M\ta\.txt$/m.test(got), `depth: a depth-2 publisher checkout must derive the candidate's change set, got ${got?.message ?? JSON.stringify(got)}`);
      }
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

async function certifiedCases() {
  const real = certifiedWorld();
  // The fixture is the real thing: the witness bytes hash to the API digest.
  const witnessArt = real.artifacts.find((a) => /witness/.test(a.name));
  check(`sha256:${sha256(real.zip)}` === witnessArt.digest, "certified: the authentic witness ZIP no longer matches its API digest");

  // 1. The authentic run is certified; its executed-route refusal is the one root reproduced.
  check(coverageOf(real.jobs, ADOPTED_SHAPE) === COVERAGE_CERTIFIED, "certified: the authentic 191d run is not read as certified");
  let executed = null;
  try { judgeProducerRoster(real.jobs, { ...rosterArgs(real), coverage: COVERAGE_EXECUTED }); } catch (error) { executed = error; }
  check(executed instanceof Unavailable && /Keep the witness \(reuse only\)/.test(executed.message),
    `certified: the executed route must still refuse the authentic run as root reproduced, got ${executed?.message}`);
  let certifiedRoster = null;
  try { certifiedRoster = judgeProducerRoster(real.jobs, { ...rosterArgs(real), coverage: COVERAGE_CERTIFIED }); } catch (error) {
    certifiedRoster = error;
  }
  check(certifiedRoster?.coverage === COVERAGE_CERTIFIED, `certified: the authentic roster fails the certified judge: ${certifiedRoster?.message}`);

  // 2. Genuine witness authenticated, then F's judge asks for the source records
  //    this fixture does not hold: Unavailable (auto builds), and never before
  //    the witness itself was read and bound.
  const calls = [];
  const absent = await certifiedOutcome(real, { calls });
  check(absent.error instanceof Unavailable && /certified full proof is unavailable/.test(absent.error.message)
    && calls.some((c) => c.endsWith(`/artifacts/${witnessArt.id}/zip`)) && calls.some((c) => c.includes(`/commits/${MAIN_SHA}/pulls`)),
  `certified: a genuine witness without its source records must be Unavailable after binding, got ${absent.error?.message ?? "a pass"}`);

  // 3. Witness negatives, each for its own reason.
  const mutate = (fn) => { const w = clone({ ...real, zip: undefined }); w.zip = Buffer.from(real.zip); fn(w); return w; };
  const cases = [
    ["missing witness", (w) => { w.artifacts = w.artifacts.filter((a) => !/witness/.test(a.name)); }, Unavailable, /retains no main witness/],
    ["two witnesses", (w) => { w.artifacts.push({ ...clone(witnessArt), id: 1, name: "relayium-ci-evidence-witness-macos-attempt-2" }); },
      Unavailable, /re-decided witness is not supported/],
    ["expired witness", (w) => { w.artifacts.find((a) => /witness/.test(a.name)).expired = true; }, Unavailable, /has expired/],
    ["altered ZIP bytes", (w) => { w.zip[w.zip.length - 30] ^= 1; }, Refused, /do not match its API digest/],
    ["witness from another run", (w) => { w.artifacts.find((a) => /witness/.test(a.name)).workflow_run.id += 1; }, Refused,
      /is not from run/],
    ["wrong attempt name", (w) => { w.artifacts.find((a) => /witness/.test(a.name)).name = "relayium-ci-evidence-witness-macos-attempt-2"; },
      Refused, /targets .* attempt 1 .* attempt 2/],
  ];
  // Certify capture and witness clock, bound to the authenticated original
  // executions (all read BEFORE F's judge, so the authentic fixture reaches them).
  const stepOf = (w, job, name) => byName(w, job).steps.find((st) => st.name === name);
  cases.push(
    ["certify capture skipped", (w) => { stepOf(w, "certify-macos", "Certify this runner's toolchain now").conclusion = "skipped"; },
      Refused, /\(certify-macos\) did not execute "Certify this runner's toolchain now" exactly once/],
    ["certify handover missing", (w) => { const j = byName(w, "certify-macos"); j.steps = j.steps.filter((st) => st.name !== "Hand the certificates to the evidence job"); },
      Refused, /did not execute "Hand the certificates to the evidence job" exactly once \(absent\)/],
    ["certify on Ubuntu", (w) => { byName(w, "certify-macos").labels = ["ubuntu-latest"]; }, Refused, /captured on \["ubuntu-latest"\]/],
    ["certify job failed", (w) => { byName(w, "certify-macos").conclusion = "failure"; }, Refused, /`certify-macos` \(attempt 1 inventory\) is completed\/failure, not a completed success/],
    ["certify capture after the decision", (w) => {
      const st = stepOf(w, "certify-macos", "Hand the certificates to the evidence job");
      st.started_at = st.completed_at = "2026-10-05T13:02:40Z";
    }, Refused, /did not finish before the evidence decision began/],
    ["certify capture two hours before the witness", (w) => {
      stepOf(w, "certify-macos", "Certify this runner's toolchain now").started_at = "2026-10-05T11:00:00Z";
    }, Refused, /certify capture began more than 30 minutes before the witness was verified at 2026-10-05T13:02:30Z/],
    // The whole certify job 45 minutes earlier, every step window shifted
    // together: ordering, decision, keep and creation all still hold, so
    // only F's 30-minute current-certificate age refuses it.
    ["whole certify job 45 minutes before the witness", (w) => {
      const j = byName(w, "certify-macos");
      const shift = (t) => new Date(Date.parse(t) - 45 * 60_000).toISOString().replace(".000Z", "Z");
      for (const key of ["started_at", "completed_at", "created_at"]) if (j[key]) j[key] = shift(j[key]);
      for (const st of j.steps) { st.started_at = shift(st.started_at); st.completed_at = shift(st.completed_at); }
    }, Refused, /certify capture began more than 30 minutes before the witness was verified at 2026-10-05T13:02:30Z/],
    ["witness verified outside its decision step", (w) => {
      const st = stepOf(w, "evidence", "Does the merged pull request's full proof cover this main tree?");
      st.completed_at = "2026-10-05T13:02:25Z";
    }, Refused, /verified at 2026-10-05T13:02:30Z, outside the decision step/],
    ["witness artifact created outside its keep step", (w) => {
      w.artifacts.find((a) => /witness/.test(a.name)).created_at = "2026-10-05T13:05:00Z";
    }, Refused, /created at 2026-10-05T13:05:00Z, outside the step that kept it/],
  );
  for (const [name, fn, type, reason] of cases) {
    const result = await certifiedOutcome(mutate(fn));
    check(result.error instanceof type && reason.test(result.error.message),
      `certified: ${name}: want ${type.name} ${reason}, got ${result.error?.constructor?.name} ${result.error?.message ?? "a pass"}`);
  }

  // 4. Roster negatives: contract/signed-build never certified; mixed or foreign
  //    steps, wrong runner, missing confirmation are neither mode.
  // A certified run's witness/evidence contradictions are Refused (never a
  // rebuild); contract and signed-build keep the executed rule (Unavailable).
  const rosterCase = (name, fn, reason, want = Refused) => {
    const w = mutate(fn);
    let error = null;
    try { judgeProducerRoster(w.jobs, { ...rosterArgs(w), coverage: coverageOf(w.jobs, ADOPTED_SHAPE) }); } catch (e) { error = e; }
    check(error instanceof want && reason.test(error.message),
      `certified roster: ${name}: want ${want.name} ${reason}, got ${error?.message ?? "a pass"}`);
  };
  rosterCase("test ran its suite beside the witness", (w) => {
    byName(w, "test").steps.find((s) => s.name === "Release script tests").conclusion = "success";
  }, /executed "Release script tests" .* beside its witness/);
  rosterCase("a UI shard ran the other shard's suite", (w) => {
    byName(w, "ui-smoke (app-shell").steps.find((s) => /UI smoke \(app-shell\)/.test(s.name)).name = "Run macOS product-flow UI smoke (device-inbox)";
    byName(w, "ui-smoke (app-shell").steps.find((s) => /device-inbox/.test(s.name)).conclusion = "success";
  }, /beside its witness/);
  rosterCase("a witness confirmation skipped", (w) => {
    byName(w, "ui-smoke (device-inbox").steps.find((s) => s.name.startsWith("Witness")).conclusion = "skipped";
  }, /did not confirm its witness exactly once/);
  rosterCase("a duplicated confirmation", (w) => {
    const j = byName(w, "ui-smoke (app-shell");
    j.steps.push({ ...clone(j.steps.find((s) => s.name.startsWith("Witness"))), number: 99 });
  }, /did not confirm its witness exactly once/);
  rosterCase("a witness on macOS", (w) => { byName(w, "test").labels = ["macos-15"]; }, /witness path runs on/);
  // Contract and signed-build are never certified, and in a certified run they
  // are KNOWN mandatory executions: a contradiction is Refused (decide passes a
  // Refused through in auto and reuse alike), not rebuilt over. Only a job
  // still running is not yet evidence (Unavailable).
  rosterCase("contract skipped its gate", (w) => {
    byName(w, "contract").steps.find((s) => s.name === "Validate release contract").conclusion = "skipped";
  }, /\(contract\) did not execute "Validate release contract" \(completed\/skipped\)/);
  rosterCase("contract gate step failed", (w) => {
    byName(w, "contract").steps.find((s) => s.name === "Validate release contract").conclusion = "failure";
  }, /\(contract\) did not execute "Validate release contract" \(completed\/failure\)/);
  rosterCase("contract job failed", (w) => { byName(w, "contract").conclusion = "failure"; },
    /`contract` job is completed\/failure; every gate job must succeed/);
  rosterCase("contract still running", (w) => { const j = byName(w, "contract"); j.status = "in_progress"; j.conclusion = null; },
    /`contract` job is in_progress\/null/, Unavailable);
  rosterCase("contract step record malformed", (w) => { byName(w, "contract").steps[0].status = 7; },
    /\(contract\) has a malformed step record/);
  rosterCase("signed-build skipped its build", (w) => {
    byName(w, "signed-build").steps.find((s) => s.name === "Build (signed, Release)").conclusion = "skipped";
  }, /\(signed-build\) did not execute "Build \(signed, Release\)" \(completed\/skipped\)/);
  rosterCase("signed-build omitted signing", (w) => {
    const j = byName(w, "signed-build");
    j.steps = j.steps.filter((s) => s.name !== "Re-sign Sparkle distribution components");
  }, /\(signed-build\) has 0 "Re-sign Sparkle distribution components" step\(s\)/);
  rosterCase("signed-build on the wrong runner", (w) => { byName(w, "signed-build").labels = ["ubuntu-latest"]; },
    /\(signed-build\) ran on \["ubuntu-latest"\]/);
  rosterCase("signed-build job failed", (w) => { byName(w, "signed-build").conclusion = "failure"; },
    /`signed-build` job is completed\/failure; every gate job must succeed/);
  rosterCase("signed-build still running", (w) => { const j = byName(w, "signed-build"); j.status = "queued"; j.conclusion = null; },
    /`signed-build` job is queued\/null/, Unavailable);
  rosterCase("contract reports no step records", (w) => { byName(w, "contract").steps = []; },
    /\(contract\) reports no step records/, Unavailable);
  // The executed route is unchanged: the same contradiction there is Unavailable.
  {
    const w = mutate((x) => { byName(x, "contract").steps.find((s) => s.name === "Validate release contract").conclusion = "skipped"; });
    for (const j of w.jobs) for (const st of j.steps ?? []) {
      if ([...WITNESS, "Keep the witness (reuse only)", "Hand the decision to the lane only once its witness is kept"].includes(st.name)) st.conclusion = "skipped";
    }
    let error = null;
    try { judgeProducerRoster(w.jobs, { ...rosterArgs(w), coverage: coverageOf(w.jobs, ADOPTED_SHAPE) }); } catch (e) { error = e; }
    check(error instanceof Unavailable && /\(contract\) did not execute "Validate release contract"/.test(error.message),
      `certified roster: an executed-route contract that skipped its gate stays Unavailable, got ${error?.constructor?.name} ${error?.message}`);
  }
  rosterCase("evidence handover skipped", (w) => {
    byName(w, "evidence").steps.find((s) => s.name.startsWith("Hand the decision")).conclusion = "skipped";
  }, /did not execute "Hand the decision/);
  let never = null;
  try { judgeWitnessed("contract", byName(real, "test")); } catch (e) { never = e; }
  check(never instanceof Refused && /can never be covered by a witness/.test(never.message),
    `certified: a witnessed contract must be refused outright, got ${never?.message}`);
  // A confirmed test witness without a KEPT decision is still a run that meant
  // to be certified: it is judged so and refused, not rebuilt over.
  const unkept = mutate((w) => { byName(w, "evidence").steps.find((s) => s.name === "Keep the witness (reuse only)").conclusion = "skipped"; });
  check(coverageOf(unkept.jobs, ADOPTED_SHAPE) === COVERAGE_CERTIFIED, "certified: an unkept witness still declares certified intent");
  rosterCase("a confirmed witness whose decision was never kept", (w) => {
    byName(w, "evidence").steps.find((s) => s.name === "Keep the witness (reuse only)").conclusion = "skipped";
  }, /did not execute "Keep the witness \(reuse only\)" exactly once/);
  rosterCase("a FAILED confirmation (job reported failure)", (w) => {
    const j = byName(w, "test");
    j.steps.find((s) => s.name.startsWith("Witness")).conclusion = "failure";
    j.conclusion = "failure";
  }, /`test` job is completed\/failure/);
  rosterCase("a failed confirmation under a green job", (w) => {
    byName(w, "test").steps.find((s) => s.name.startsWith("Witness")).conclusion = "failure";
  }, /did not confirm its witness exactly once/);
  rosterCase("witness intent ONLY in a UI shard (test executed)", (w) => {
    for (const st of byName(w, "test").steps) if (st.name.startsWith("Witness")) st.conclusion = "skipped";
  }, /\(test\) did not confirm its witness exactly once/);
  // Every witness step skipped everywhere and nothing kept: the executed route.
  const none = mutate((w) => {
    for (const j of w.jobs) for (const st of j.steps ?? []) {
      if ([...WITNESS, "Keep the witness (reuse only)", "Hand the decision to the lane only once its witness is kept"].includes(st.name)) st.conclusion = "skipped";
    }
  });
  check(coverageOf(none.jobs, ADOPTED_SHAPE) === COVERAGE_EXECUTED, "certified: a run with no witness intent must stay on the executed route");
}

/**
 * The witness clock against F's current-certificate age, judged directly on
 * consistent step windows (each case moves every window it needs, so no
 * unrelated ordering guard refuses it first). F verified the witness at
 * `verified_at`; the capture happened no earlier than the certify step's
 * skew-widened start, so `verified - (start - skew)` must be <= 30 minutes.
 */
async function timingCases() {
  const F = await import("../ci/ci-evidence.mjs");
  check(CERTIFY_TO_VERIFIED_MAX_MS === F.CURRENT_CERT_MAX_AGE_MS && CERTIFY_TO_VERIFIED_MAX_MS === 30 * 60_000,
    `timing: the reader's limit ${CERTIFY_TO_VERIFIED_MAX_MS} is not F's canonical ${F.CURRENT_CERT_MAX_AGE_MS}`);
  const iso = (ms) => new Date(ms).toISOString();
  const T0 = Date.parse("2026-10-05T12:00:00Z");
  const SKEW = 2_000;
  const world = ({ capture = [0, 20_000], hand = [20_000, 20_000], decide = [30_000, 40_000], verified = 39_000,
    keep = [40_000, 41_000], created = 41_000 } = {}) => ({
    certify: { steps: [
      { name: "Certify this runner's toolchain now", started_at: iso(T0 + capture[0]), completed_at: iso(T0 + capture[1]) },
      { name: "Hand the certificates to the evidence job", started_at: iso(T0 + hand[0]), completed_at: iso(T0 + hand[1]) },
    ] },
    evidence: { steps: [
      { name: "Does the merged pull request's full proof cover this main tree?", started_at: iso(T0 + decide[0]), completed_at: iso(T0 + decide[1]) },
      { name: "Keep the witness (reuse only)", started_at: iso(T0 + keep[0]), completed_at: iso(T0 + keep[1]) },
    ] },
    witness: { verified_at: iso(T0 + verified) },
    art: { id: 7, created_at: iso(T0 + created) },
  });
  const MIN = 60_000;
  const LIMIT = CERTIFY_TO_VERIFIED_MAX_MS;
  const AGE = /certify capture began more than 30 minutes before the witness was verified/;
  // Decision and keep windows placed late enough around `v` for the age to be the only question.
  const late = (v, decideFrom = v - 5_000) => ({ decide: [decideFrom, v + 1_000], verified: v, keep: [v + 1_000, v + 2_000], created: v + 2_000 });
  const table = [
    ["a prompt capture", {}, null],
    ["exactly 30 minutes (skew-widened start)", late(LIMIT - SKEW), null],
    ["one millisecond over 30 minutes", late(LIMIT - SKEW + 1), AGE],
    ["just over 30 minutes by a whole second", late(LIMIT), AGE],
    ["45 minutes", late(45 * MIN), AGE],
    // Capture within 30 minutes of the decision START, but the decision ran
    // long and verified the witness 35 minutes after the capture began.
    ["a long decision", { decide: [MIN, 40 * MIN], verified: 35 * MIN, keep: [40 * MIN, 40 * MIN + 1_000], created: 40 * MIN + 1_000 }, AGE],
    ["a capture finishing after the decision began", { hand: [20_000, 40_000] }, /did not finish before the evidence decision began/],
    ["a witness verified after its decision step", { verified: 50_000, keep: [50_000, 51_000], created: 51_000 },
      /outside the decision step that produced it/],
    ["a witness verified before its decision step", { verified: 20_000 }, /outside the decision step that produced it/],
    ["a witness artifact created outside its keep step", { created: 60_000 }, /outside the step that kept it/],
  ];
  for (const [name, at, reason] of table) {
    let error = null;
    try { judgeWitnessTiming(world(at)); } catch (e) { error = e; }
    check(reason === null ? error === null : error instanceof Refused && reason.test(error.message),
      `timing: ${name}: want ${reason ?? "accepted"}, got ${error?.message ?? "accepted"}`);
  }
  // No caller may widen the limit; F's own value is the only one it accepts.
  for (const maxAgeMs of [60 * MIN, LIMIT + 1, 0, 1.5]) {
    let error = null;
    try { judgeWitnessTiming({ ...world(), maxAgeMs }); } catch (e) { error = e; }
    check(error instanceof Refused && /is not F's canonical 1800000 ms/.test(error.message),
      `timing: a ${maxAgeMs} ms limit must be refused, got ${error?.message ?? "accepted"}`);
  }
  let error = null;
  try { judgeWitnessTiming({ ...world(late(LIMIT - SKEW)), maxAgeMs: F.CURRENT_CERT_MAX_AGE_MS }); } catch (e) { error = e; }
  check(error === null, `timing: F's own limit at the boundary must be accepted, got ${error?.message}`);
}

/**
 * The returned frozen certificates carry the exact source certificate
 * artifacts. Same toolchain VALUE, different artifact id: a different frozen
 * identity, so a readback comparing `evidenceIdentity` refuses. (Primitive
 * level: the whole certified decide/readback with these identities is root's
 * genuine replay; no hermetic whole-chain factory exists in this file.)
 */
async function identityCases() {
  const F = await import("../ci/ci-evidence.mjs");
  const opts = { attempt: 1, isIdentity: F.isArtifactIdentity };
  const digest = (c) => `sha256:${c.repeat(64)}`;
  const witnessCerts = { test: { profile: "ubuntu", current: "v1", source: ["v1"] } };
  const record = (id, patch = {}) => ({
    id, name: "relayium-ci-evidence-toolchain-macos-test-0-attempt-1", digest: digest("a"), size_in_bytes: 512,
    created_at: "2026-10-05T10:00:00Z", expires_at: "2026-10-20T00:00:00Z", expired: false,
    workflow_run: { id: 7001, head_sha: "c".repeat(40), repository_id: 42, head_repository_id: 42 }, ...patch,
  });
  const artifact = (id, patch) => F.artifactIdentityOf(record(id, patch));
  const sources = (art) => ({ test: { profile: "ubuntu", source: ["v1"], artifacts: [art] } });
  const a = frozenCertificates(witnessCerts, sources(artifact(101)), opts);
  const b = frozenCertificates(witnessCerts, sources(artifact(102)), opts);
  check(JSON.stringify(a.test.artifacts) === JSON.stringify([artifact(101)]) && a.test.source[0] === b.test.source[0]
    && JSON.stringify(Object.keys(a.test.artifacts[0])) === JSON.stringify(F.ARTIFACT_IDENTITY_KEYS),
  `identity: the frozen certificates must carry the complete artifact identity, got ${JSON.stringify(a.test)}`);
  // Every field of the complete identity is frozen: the same id and value with a
  // foreign head repository, another size, creation, expiry, digest or head is a
  // different chain.
  for (const [what, patch] of [
    ["a foreign head repository", { workflow_run: { id: 7001, head_sha: "c".repeat(40), repository_id: 42, head_repository_id: 777777 } }],
    ["a foreign repository", { workflow_run: { id: 7001, head_sha: "c".repeat(40), repository_id: 777777, head_repository_id: 42 } }],
    ["another run", { workflow_run: { id: 7002, head_sha: "c".repeat(40), repository_id: 42, head_repository_id: 42 } }],
    ["another head", { workflow_run: { id: 7001, head_sha: "d".repeat(40), repository_id: 42, head_repository_id: 42 } }],
    ["another size", { size_in_bytes: 513 }],
    ["another creation", { created_at: "2026-10-05T10:00:01Z" }],
    ["another expiry", { expires_at: "2026-10-20T00:00:01Z" }],
    ["another digest", { digest: digest("b") }],
  ]) {
    const c = frozenCertificates(witnessCerts, sources(artifact(101, patch)), opts);
    check(JSON.stringify(c) !== JSON.stringify(a), `identity: ${what} with the same id and value must change the frozen identity`);
  }
  const w = reuseWorld({ adopted: true });
  const frozen = (await decideIn(w)).value?.evidence;
  check(Boolean(frozen), "identity: the executed reuse world produced no evidence to bind");
  if (frozen) {
    const certified = (certs) => ({ ...clone(frozen), coverage: { mode: COVERAGE_CERTIFIED, certificates: certs } });
    check(evidenceIdentity(certified(a)) !== evidenceIdentity(certified(b))
      && evidenceIdentity(certified(a)) === evidenceIdentity(certified(clone(a))),
    "identity: a replaced source certificate artifact with the same value must change the frozen evidence identity");
  }
  for (const [name, art, n = 1] of [
    ["a missing digest", { ...artifact(101), digest: undefined }],
    ["an extra key", { ...artifact(101), expired: false }],
    ["a dropped key (the old four-field identity)", { id: 101, name: record(101).name, digest: digest("a"), expires_at: "2026-10-20T00:00:00Z" }],
    ["reordered keys", Object.fromEntries(Object.entries(artifact(101)).reverse())],
    ["a string id", { ...artifact(101), id: "101" }],
    ["an unreadable expiry", { ...artifact(101), expires_at: "soon" }],
    ["a non-hex head", { ...artifact(101), head_sha: "x" }],
    ["another index's name", { ...artifact(101), name: "relayium-ci-evidence-toolchain-macos-test-1-attempt-1" }],
    ["another attempt's name", { ...artifact(101), name: "relayium-ci-evidence-toolchain-macos-test-0-attempt-2" }],
    ["fewer identities than values", null, 0],
  ]) {
    let error = null;
    try { frozenCertificates(witnessCerts, { test: { profile: "ubuntu", source: ["v1"], artifacts: n === 0 ? [] : [JSON.parse(JSON.stringify(art))] } }, opts); } catch (e) { error = e; }
    check(error instanceof Refused && /artifact identities are not one strict record per certificate/.test(error.message),
      `identity: ${name} must be refused, got ${error?.message ?? "accepted"}`);
  }
  let error = null;
  try { frozenCertificates(witnessCerts, sources(artifact(101))); } catch (e) { error = e; }
  check(error !== null, "identity: freezing certificates without the source attempt must fail");
}

/**
 * The strict shared coverage schema (shape only; authenticity is the reader's).
 * A synthetic, internally consistent certified coverage — TEST DATA — is
 * accepted; each single-fact break is refused. The authentic 191d coverage
 * round-trip is root's/author's replay harness, not this file.
 */
async function coverageSchemaCases() {
  const sha = "1".repeat(40);
  const tree = "2".repeat(40);
  const id = (n, name, run, patch = {}) => ({
    id: n, name, digest: `sha256:${String(n % 10).repeat(64)}`, size_in_bytes: 900, created_at: "2026-10-05T10:22:31Z",
    expires_at: "2026-10-12T10:22:30Z", run_id: run, head_sha: sha, repository_id: 42, head_repository_id: 42, ...patch,
  });
  const v = "a".repeat(64);
  const good = () => ({
    mode: COVERAGE_CERTIFIED,
    witness: {
      artifactId: 11, name: "relayium-ci-evidence-witness-macos-attempt-1", digest: `sha256:${"1".repeat(64)}`, attempt: 1,
      expiresAt: "2026-11-04T13:02:30Z", createdAt: "2026-10-05T13:02:31Z", verifiedAt: "2026-10-05T13:02:30Z",
      identity: id(11, "relayium-ci-evidence-witness-macos-attempt-1", 500, { expires_at: "2026-11-04T13:02:30Z", created_at: "2026-10-05T13:02:31Z" }),
      target: { repository_id: 42, sha, tree, run_id: 500, run_attempt: 1, workflow_ref: "o/r/.github/workflows/macos.yml@refs/heads/main" },
    },
    executions: { "test": v, "ui-smoke (app-shell, X, 30)": v, "ui-smoke (device-inbox, Y, 30)": v, "evidence": v, "certify-macos": v },
    source: {
      kind: "merge-gate-internal-full-candidate-run", runId: 400, attempt: 1, testedSha: sha, tree, artifactId: 21,
      digest: `sha256:${"1".repeat(64)}`, producedAt: "2026-10-05T10:48:30Z", fingerprint: v,
      certification: { registry_sha256: v, verifier_sha256: v, selector_sha256: v, toolchain_sha256: v, toolchain_registry_sha256: v },
      proofName: "relayium-ci-evidence-proof-attempt-1", runUpdatedAt: "2026-10-05T10:48:34Z", headSha: sha, pullRequest: null,
      proofIdentity: id(21, "relayium-ci-evidence-proof-attempt-1", 400),
    },
    certificates: {
      test: { profile: "macos-xcode", current: v, source: [v], artifacts: [id(31, "relayium-ci-evidence-toolchain-macos-test-0-attempt-1", 400)] },
      "ui-smoke": { profile: "macos-xcode", current: v, source: [v, v], artifacts: [
        id(32, "relayium-ci-evidence-toolchain-macos-ui-smoke-0-attempt-1", 400),
        id(33, "relayium-ci-evidence-toolchain-macos-ui-smoke-1-attempt-1", 400)] },
    },
  });
  const accepted = (c) => { try { validateCoverage(c); return null; } catch (e) { return e; } };
  check(accepted(good()) === null, `coverage: the consistent certified coverage must be accepted, got ${accepted(good())?.message}`);
  check(accepted({ mode: "executed" }) === null, "coverage: the executed coverage must be accepted");
  for (const [what, mutate] of [
    ["an extra top-level key", (c) => { c.extra = 1; }],
    ["an executed coverage with an extra key", (c) => { for (const k of Object.keys(c)) delete c[k]; Object.assign(c, { mode: "executed", x: 1 }); }],
    ["an unknown mode", (c) => { c.mode = "certified"; }],
    ["four executions", (c) => { delete c.executions.evidence; }],
    ["an unknown execution role", (c) => { delete c.executions.evidence; c.executions.contract = c.executions.test; }],
    ["two ui-smoke app-shell executions", (c) => { delete c.executions["ui-smoke (device-inbox, Y, 30)"]; c.executions["ui-smoke (app-shell, Z, 30)"] = c.executions.test; }],
    ["a non-hex execution", (c) => { c.executions.test = "x"; }],
    ["a witness id disagreeing with its identity", (c) => { c.witness.artifactId = 12; }],
    ["a witness of another target run", (c) => { c.witness.target.run_id = 501; }],
    ["a witness target attempt not the witness attempt", (c) => { c.witness.target.run_attempt = 2; }],
    ["a witness target workflow off main", (c) => { c.witness.target.workflow_ref = "o/r/.github/workflows/macos.yml@refs/heads/x"; }],
    ["an old array witness identity", (c) => { c.witness.identity = Object.values(c.witness.identity); }],
    ["a source tree not the target tree", (c) => { c.source.tree = "3".repeat(40); }],
    ["a pull request on an internal kind", (c) => { c.source.pullRequest = 7; }],
    ["no pull request on a pull-request kind", (c) => { c.source.kind = "merge-gate-pull-request-full-run"; }],
    ["a missing certification hash", (c) => { delete c.source.certification.selector_sha256; }],
    ["a proof identity of another run", (c) => { c.source.proofIdentity.run_id = 401; }],
    ["a proof identity of another id", (c) => { c.source.proofIdentity.id = 22; }],
    ["a proof identity with a foreign head repository type", (c) => { c.source.proofIdentity.head_repository_id = "777777"; }],
    ["a proof name of another attempt", (c) => { c.source.proofName = "relayium-ci-evidence-proof-attempt-2"; c.source.proofIdentity.name = c.source.proofName; }],
    ["the dropped proofExpiresAt key back", (c) => { c.source.proofExpiresAt = c.source.proofIdentity.expires_at; }],
    ["a missing runUpdatedAt", (c) => { delete c.source.runUpdatedAt; }],
    ["certificates in another order", (c) => { c.certificates = { "ui-smoke": c.certificates["ui-smoke"], test: c.certificates.test }; }],
    ["a third certified job", (c) => { c.certificates.contract = c.certificates.test; }],
    ["fewer artifacts than values", (c) => { c.certificates["ui-smoke"].artifacts.pop(); }],
    ["certificate artifacts swapped by index", (c) => { c.certificates["ui-smoke"].artifacts.reverse(); }],
    ["a certificate of another attempt", (c) => { c.certificates.test.artifacts[0].name = "relayium-ci-evidence-toolchain-macos-test-0-attempt-2"; }],
    ["a certificate of another run", (c) => { c.certificates.test.artifacts[0].run_id = 401; }],
    ["a repeated artifact id", (c) => { c.certificates.test.artifacts[0].id = 21; }],
    ["a source value not the current value", (c) => { c.certificates.test.source = ["b".repeat(64)]; }],
    ["a four-field certificate identity", (c) => { const a = c.certificates.test.artifacts[0]; c.certificates.test.artifacts[0] = { id: a.id, name: a.name, digest: a.digest, expires_at: a.expires_at }; }],
  ]) {
    const c = good();
    mutate(c);
    const error = accepted(c);
    check(error instanceof Refused && /the coverage is malformed/.test(error.message), `coverage: ${what} must be refused, got ${error?.message ?? "accepted"}`);
  }
  // The historical reader takes no ambient Git, no derived expectation and no executed record.
  const api = { get: async () => { throw new Error("no API read may precede the argument checks"); }, download: async () => { throw new Error("no download"); } };
  for (const [what, opts] of [
    ["no source Git adapter", { expectedCoverage: good() }],
    ["no frozen coverage", { sourceGit: () => Buffer.alloc(0) }],
    ["an executed frozen coverage", { sourceGit: () => Buffer.alloc(0), expectedCoverage: { mode: "executed" } }],
    ["a malformed frozen coverage", { sourceGit: () => Buffer.alloc(0), expectedCoverage: { ...good(), extra: 1 } }],
    ["a clock that is not a function", { sourceGit: () => Buffer.alloc(0), expectedCoverage: good(), clock: 5 }],
  ]) {
    let error = null;
    try { await verifyHistoricalCertifiedCoverage(api, { repository: "o/r", repositoryId: 42, sha, run: { id: 500 }, ...opts }); } catch (e) { error = e; }
    check(error instanceof Refused, `historical: ${what} must be refused before any read, got ${error?.message ?? "accepted"}`);
  }
}

export async function wholeCertifiedCases() {
  const firstCase = cases, firstFailure = failures.length;
  const world = await createCertifiedGitWorld();
  try {
  let sequence = 0;
  const options = () => ({ repository: world.repository, repositoryId: world.repositoryId,
    sha: world.sha, ref: 'refs/heads/main', releaseVersion: '1.4.5', now: world.now.getTime(),
    dir: join(world.directory, `selection-${++sequence}`) });
  const frozen = await world.inCheckout(async () => {
    const automatic = await decide(world.api, { ...options(), mode: 'auto' });
    check(automatic.source === 'reuse' && automatic.evidence?.coverage?.mode === COVERAGE_CERTIFIED,
      'whole real-Git chain: actual produce/witness must allow automatic certified reuse');
    world.reset();
    const forced = await decide(world.api, { ...options(), mode: 'reuse' });
    check(evidenceIdentity(automatic.evidence) === evidenceIdentity(forced.evidence),
      'whole real-Git chain: auto and forced reuse freeze the same identity');
    world.reset();
    const back = await readback(world.api, automatic.evidence, { now: world.now.getTime(),
      releaseVersion: '1.4.5', dir: join(world.directory, 'initial-readback') });
    check(evidenceIdentity(back) === evidenceIdentity(automatic.evidence), 'whole real-Git chain: readback identity');
    check(createHash('sha256').update(readFileSync(join(world.directory, 'initial-readback/Relayium.dmg'))).digest('hex') === world.dmgSha256,
      'whole real-Git chain: independently hash the installed payload');
    return automatic.evidence;
  });
  const historical = (coverage = frozen.coverage, clock = () => world.now.getTime()) =>
    verifyHistoricalCertifiedCoverage(world.api, { repository: world.repository, repositoryId: world.repositoryId,
      sha: world.sha, run: world.main, rosterJobs: ['test', 'ui-smoke/app-shell', 'ui-smoke/device-inbox']
        .map((id, index) => ({ id, job: world.mainJobs[index + 1] })),
      evidenceJob: world.mainJobs.find(j => j.name === 'evidence'),
      certifyJob: world.mainJobs.find(j => j.name === 'certify-macos'), expectedCoverage: coverage,
      clock, sourceGit: world.runGit });
  const refuseReadback = async (label, pattern, now = world.now.getTime()) => {
    let error;
    try { await world.inCheckout(() => readback(world.api, frozen, { now,
      dir: join(world.directory, `negative-${++sequence}`), releaseVersion: '1.4.5' })); } catch (e) { error = e; }
    check(error instanceof Refused && pattern.test(error.message), `${label}: must refuse for ${pattern}, got ${error?.message ?? 'accepted'}`);
  };
    world.reset();
    const retained = await historical();
    check(JSON.stringify(retained) === JSON.stringify(frozen.coverage), 'whole historical reader: same frozen coverage');
    // This changes only the clock: proof, witness and Git objects remain identical.
    world.reset();
    const later = world.now.getTime() + 49 * 3600000;
    const oldSelection = await world.inCheckout(() => decide(world.api, { ...options(), now: later, mode: 'auto' }));
    check(oldSelection.source === 'build' && /outside 48h/.test(oldSelection.reason),
      `whole age mirror: new reuse expires after 48 hours, got ${oldSelection.source}/${oldSelection.reason}`);
    world.reset();
    const oldRetained = await historical(frozen.coverage, () => later);
    check(JSON.stringify(oldRetained) === JSON.stringify(frozen.coverage), 'whole age mirror: original eligibility remains historically verifiable');
    world.reset();
    let forcedAgeError;
    try { await world.inCheckout(() => decide(world.api, { ...options(), now: later, mode: 'reuse' })); } catch (e) { forcedAgeError = e; }
    check(forcedAgeError instanceof Refused && /outside 48h/.test(forcedAgeError.message), 'whole age mirror: forced reuse refuses stale source');
    world.reset();
    await refuseReadback('whole age mirror: readback refuses stale source', /outside 48h/, later);
    world.reset();
    const changedExpected = structuredClone(frozen.coverage);
    const executionName = Object.keys(changedExpected.executions)[0];
    changedExpected.executions[executionName] = '0'.repeat(64);
    let mismatchError; try { await historical(changedExpected); } catch (e) { mismatchError = e; }
    check(mismatchError instanceof Refused && mismatchError.message === 'the certified coverage read back now differs from the coverage the release froze',
      'whole historical reader refuses well-formed mismatched frozen execution');

    const certificate = world.artifacts.find(a => a.name === 'relayium-ci-evidence-toolchain-macos-test-0-attempt-1');
    const recordRoute = `repos/${world.repository}/actions/artifacts/${certificate.id}`;
    const raceMessage = `artifact ${certificate.name} (${certificate.id}) changed, was replaced, re-attributed or expired while the chain was being verified`;
    for (const [key, value] of [['id', certificate.id + 100000], ['name', certificate.name + '-other'],
      ['digest', 'sha256:' + '0'.repeat(64)], ['size_in_bytes', certificate.size_in_bytes + 1],
      ['created_at', new Date(Date.parse(certificate.created_at) + 1000).toISOString().replace('.000Z', 'Z')],
      ['expires_at', new Date(Date.parse(certificate.expires_at) + 1000).toISOString().replace('.000Z', 'Z')],
      ['run_id', certificate.workflow_run.id + 1], ['head_sha', 'f'.repeat(40)],
      ['repository_id', 777777], ['head_repository_id', 777777]]) {
      world.reset();
      world.hooks.set(recordRoute, n => {
        if (n !== 1) return;
        const changed = structuredClone(certificate);
        if (['run_id', 'head_sha', 'repository_id', 'head_repository_id'].includes(key)) changed.workflow_run[key === 'run_id' ? 'id' : key] = value;
        else changed[key] = value;
        return changed;
      });
      await refuseReadback(`whole certificate end-record race ${key}`, new RegExp('^' + raceMessage.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$'));
      check(world.counters.get(recordRoute) === 1, `whole certificate ${key}: mutated the final record read`);
    }
    world.reset();
    const listRoute = `repos/${world.repository}/actions/runs/${world.source.id}/artifacts?name=${certificate.name}&per_page=100&page=1`;
    world.hooks.set(listRoute, n => n >= 2 ? { total_count: 1, artifacts: [{ ...structuredClone(certificate),
      workflow_run: { ...certificate.workflow_run, head_repository_id: 777777 } }] } : undefined);
    await refuseReadback('whole certificate end-list foreign repository', /changed|identity|disagree|replaced/i);
    check(world.counters.get(listRoute) === 2, 'whole foreign repository: mutated the second certificate list');

    world.reset();
    const originalId = certificate.id;
    const originalBytes = world.zipBytes.get(originalId);
    certificate.id += 100000;
    world.zipBytes.set(certificate.id, originalBytes);
    try {
      await refuseReadback('whole same-value certificate replacement', /^the evidence read back now differs from the evidence the preflight froze$/);
      world.reset();
      let replacedError; try { await historical(); } catch (e) { replacedError = e; }
      check(replacedError instanceof Refused && replacedError.message === 'the certified coverage read back now differs from the coverage the release froze',
        'whole historical reader refuses same-value certificate replacement against frozen identity');
    }
    finally { world.zipBytes.delete(certificate.id); certificate.id = originalId; }

    world.reset();
    const proofArtifact = world.artifacts.find(a => a.id === frozen.coverage.source.artifactId);
    const originalExpiry = proofArtifact.expires_at;
    proofArtifact.expires_at = new Date(world.now.getTime() + 3 * 3600000).toISOString().replace('.000Z', 'Z');
    try {
      const nearExpiry = await world.inCheckout(() => decide(world.api, { ...options(), mode: 'auto' }));
      check(nearExpiry.source === 'build' && /expires in under 6 hours/.test(nearExpiry.reason), 'whole proof expiry headroom: rebuild before selection');
      const expected = structuredClone(frozen.coverage);
      expected.source.proofIdentity.expires_at = proofArtifact.expires_at;
      world.reset();
      const nearHistorical = await historical(expected);
      check(JSON.stringify(nearHistorical) === JSON.stringify(expected), 'whole proof expiry headroom: historical reader uses actual expiry');
      proofArtifact.expires_at = new Date(world.now.getTime() - 1000).toISOString().replace('.000Z', 'Z');
      expected.source.proofIdentity.expires_at = proofArtifact.expires_at;
      world.reset();
      let error; try { await historical(expected); } catch (e) { error = e; }
      check(error instanceof Refused && /expired|expiry/i.test(error.message), 'whole historical reader refuses actually expired proof');
      world.reset();
      let forcedExpiryError;
      try { await world.inCheckout(() => decide(world.api, { ...options(), mode: 'reuse' })); } catch (e) { forcedExpiryError = e; }
      check(forcedExpiryError instanceof Refused && /expired/.test(forcedExpiryError.message), 'whole expired proof: forced reuse refuses');
      world.reset();
      await refuseReadback('whole expired proof: readback refuses', /expired/);
    } finally { proofArtifact.expires_at = originalExpiry; }

    world.reset();
    const originalRun = structuredClone(world.main);
    const carriedJobs = structuredClone(world.mainJobs).map(j => ({ ...j, id: j.id + 10000, run_attempt: 2 }));
    world.main.run_attempt = 2;
    world.attemptJobs.get(world.main.id).set(2, carriedJobs);
    world.originalRuns.get(world.main.id).set(2, structuredClone(world.main));
    try {
      const carried = await world.inCheckout(() => decide(world.api, { ...options(), mode: 'reuse' }));
      check(carried.source === 'reuse' && JSON.stringify(carried.evidence.coverage) === JSON.stringify(frozen.coverage)
        && JSON.stringify(carried.evidence.signedBuildOrigin) === JSON.stringify(frozen.signedBuildOrigin),
        'whole carried attempt: original executions and coverage survive wrapper relabels');
      world.reset();
      await refuseReadback('whole carried attempt: frozen latest wrapper cannot silently change', /^the evidence read back now differs from the evidence the preflight froze$/);
      world.reset();
      const signed = carriedJobs.find(j => j.name === 'signed-build');
      signed.steps[0].started_at = new Date(Date.parse(signed.steps[0].started_at) + 1000).toISOString().replace('.000Z', 'Z');
      await refuseReadback('whole re-executed signed build refuses original provenance', /not the original execution|execution.*differ|different execution/);
    } finally { Object.assign(world.main, originalRun); world.attemptJobs.get(world.main.id).delete(2); world.originalRuns.get(world.main.id).delete(2); }
    world.reset();
    const malformed = structuredClone(frozen.coverage); malformed.source.extra = 'untrusted';
    let schemaError; try { await historical(malformed); } catch (e) { schemaError = e; }
    check(schemaError instanceof Refused && world.calls.length === 0, 'whole strict schema refusal precedes API reads');
    const cwd = process.cwd();
    world.reset();
    let advancingNow = world.now.getTime(), advanced = false;
    world.hooks.set(recordRoute, () => { advanced = true; advancingNow = Date.parse(certificate.expires_at) + 1000; });
    let clockError;
    try { await historical(frozen.coverage, () => advancingNow); } catch (e) { clockError = e; }
    check(advanced && clockError instanceof Refused && /expired while the chain was being verified/.test(clockError.message),
      'whole historical reader rechecks fresh clock after final certificate API read');
    world.reset();
    const poisonKeys = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE'];
    const ambient = new Map(poisonKeys.map(key => [key, process.env[key]]));
    process.env.GIT_DIR = join(world.directory, 'poison.git');
    process.env.GIT_WORK_TREE = world.directory;
    process.env.GIT_INDEX_FILE = join(world.directory, 'poison.index');
    const poisoned = Object.fromEntries(poisonKeys.map(key => [key, process.env[key]]));
    try {
      check(Object.keys(isolatedGitEnvironment()).every(key => !key.startsWith('GIT_')),
        'whole fixture environment sanitizer removes poison keys at call time');
      const safe = await world.inCheckout(() => decide(world.api, { ...options(), mode: 'reuse' }));
      check(safe.source === 'reuse' && poisonKeys.every(key => process.env[key] === poisoned[key]),
        'whole fixture ignores inherited Git paths and restores caller environment');
      check(world.runGit(['rev-parse', 'HEAD']).toString().trim() === world.sha,
        'whole source Git adapter ignores inherited Git paths');
    } finally { for (const [key, value] of ambient) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } }
    let nestedError;
    await world.inCheckout(async () => { try { await world.inCheckout(() => Promise.resolve()); } catch (e) { nestedError = e; } });
    check(nestedError?.message.includes('already held') && process.cwd() === cwd, 'whole fixture rejects reentrancy and restores cwd');
    try { await world.inCheckout(() => { throw new Error('fixture cancellation'); }); } catch {}
    check(process.cwd() === cwd, 'whole fixture restores cwd after a failed operation');
    await world.inCheckout(() => Promise.resolve());
    check(process.cwd() === cwd, 'whole fixture releases lock after a failed operation');
  } finally { world.dispose(); }
  return { cases: cases - firstCase, failures: failures.slice(firstFailure) };
}

export async function run() {
  archiveCases();
  destinationCases();
  await reuseCases();
  await executionCases();
  await gateCases();
  await preflightCases();
  await frozenCases();
  await deliverCases();
  await gateStepCases();
  verifierCases();
  contractCases();
  await certifiedCases();
  await timingCases();
  await identityCases();
  await coverageSchemaCases();
  await wholeCertifiedCases();
  depthCases();
  return { cases, failures: [...failures], generatorChecked };
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const { cases: count, failures: failed } = await run();
  for (const failure of failed) process.stderr.write(`FAIL: ${failure}\n`);
  if (failed.length > 0) {
    process.stderr.write(`\n${failed.length} of ${count} macOS evidence control(s) failed\n`);
    process.exit(1);
  }
  process.stdout.write(`ok: ${count} macOS evidence controls\n`);
}
