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
  ADOPTED_SHAPE,
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
} from "../release/macos-evidence.mjs";
import { CANDIDATE_PATHS } from "../../web/scripts/macos-release-candidate.mjs";

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
  return { name, status: "completed", conclusion, number: index + 1 };
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
/** The frozen previous adoption: contract witnessed and certified on Ubuntu. */
const witnessedContractText = () => adoptedText(LEGACY_WORKFLOW, { witnessedContract: true });

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
function reuseWorld({ adopted = false, witnessedContract = false } = {}) {
  if (witnessedContract) adopted = true;
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
    workflowText: witnessedContract ? witnessedContractText() : adopted ? adoptedText() : LEGACY_WORKFLOW,
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
    const got = await decideIn(w);
    check(got.value?.source === "reuse" && got.value.evidence.jobs[4].runAttempt === 1,
      `select: a partial rerun keeping the attempt-1 signed-build was not reused: ${got.error?.message ?? got.value?.reason}`);
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
  for (const [name, adopted, shape, jobs, mutate] of [
    ["a legacy five-job full producer", false, "legacy", 5, () => {}],
    ["a canonical adopted producer (screen no, certify skipped) that executed natively", true, ADOPTED_SHAPE, 8, () => {}],
    ["a canonical adopted producer whose fresh contract ran on its event's runner", true, ADOPTED_SHAPE, 8, (w) => {
      check(JSON.stringify(jobOf(w, "contract").steps.map((st) => st.name)) === JSON.stringify(REAL_STEPS.contract),
        "execution: the current adoption's contract fixture is not exactly its original steps");
    }],
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
    const w = reuseWorld(adopted === FROZEN ? FROZEN : { adopted });
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
    ["an Ubuntu UI shard that took the witness path", true, (w) => witnessed(jobOf(w, app)), /ran on \["ubuntu-latest"\]; `ui-smoke\/app-shell` must run on \["macos-15"\]/],
    ["a macOS UI shard whose witness succeeded and smoke was skipped", true, (w) => witnessed(jobOf(w, app), { mac: true }), /did not execute "Import UI signing certificate" \(completed\/skipped\)/],
    ["a successful witness beside an executed smoke", true, (w) => setStep(jobOf(w, app), WITNESS[2], "success"), /ran "Witness — the pull request's full proof covers this job" \(success\)/],
    ["an omitted smoke step", true, (w) => { const j = jobOf(w, app); j.steps = j.steps.filter((st) => st.name !== smoke); }, /has 0 "Run macOS product-flow UI smoke \(app-shell\)" step\(s\)/],
    ["a skipped smoke step", true, (w) => setStep(jobOf(w, app), smoke, "skipped"), /did not execute "Run macOS product-flow UI smoke \(app-shell\)" \(completed\/skipped\)/],
    ["a duplicated smoke step", true, (w) => { const j = jobOf(w, app); j.steps.push({ ...j.steps.find((st) => st.name === smoke) }); }, /has 2 "Run macOS product-flow UI smoke \(app-shell\)" step\(s\)/],
    ["a failed smoke step under a green job", true, (w) => setStep(jobOf(w, app), smoke, "failure"), /did not execute "Run macOS product-flow UI smoke \(app-shell\)" \(completed\/failure\)/],
    ["the other shard's suite run in the app-shell job", true, (w) => jobOf(w, app).steps.push({ name: "Run macOS product-flow UI smoke (device-inbox)", status: "completed", conclusion: "success" }), /ran "Run macOS product-flow UI smoke \(device-inbox\)" \(success\)/],
    ["a witnessed test job", true, (w) => witnessed(jobOf(w, "test")), /job 901 \(test\) ran on \["ubuntu-latest"\]/],
    ["a witnessed contract job", true, (w) => witnessed(jobOf(w, "contract")), /job 900 \(contract\) did not execute "Validate release contract" \(completed\/skipped\)/],
    ["a witnessed contract job under the frozen adoption", FROZEN, (w) => witnessed(jobOf(w, "contract")), /job 900 \(contract\) did not execute "Validate release contract" \(completed\/skipped\)/],
    // The current contract has no witness path: a witness step record, even skipped, is foreign to it.
    ["a skipped witness step in the always-fresh contract", true, (w) => jobOf(w, "contract").steps.unshift({ name: WITNESS[0], status: "completed", conclusion: "skipped" }), /job 900 \(contract\) ran "Check out the verifier \(witness path only\)" \(skipped\)/],
    ["a skipped confirm step in the always-fresh contract", true, (w) => jobOf(w, "contract").steps.unshift({ name: WITNESS[2], status: "completed", conclusion: "skipped" }), /job 900 \(contract\) ran "Witness — the pull request's full proof covers this job" \(skipped\)/],
    ["a fresh contract that ran on a macOS runner it never picks for a push", true, (w) => { jobOf(w, "contract").labels = ["ubuntu-latest", "macos-15"]; }, /job 900 \(contract\) ran on \["ubuntu-latest","macos-15"\]/],
    // Never a mix of the two adoptions, and never an unknown third.
    ["the current evidence job beside a witnessed contract", true, (w) => { w.workflowText = withAfterSteps(w.workflowText, "contract", CANONICAL_WITNESS_STEPS); }, /not the canonical one/],
    ["the frozen evidence job beside a fresh contract", FROZEN, (w) => { w.workflowText = withoutWitness(w.workflowText, "contract"); }, /not the canonical one/],
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
    ["an evidence job that kept a witness", true, (w) => setStep(jobOf(w, "evidence"), "Keep the witness (reuse only)", "success"), /ran "Keep the witness \(reuse only\)" \(success\)/],
    ["an evidence job that handed reuse to the lane", true, (w) => setStep(jobOf(w, "evidence"), "Hand the decision to the lane only once its witness is kept", "success"), /ran "Hand the decision to the lane only once its witness is kept" \(success\)/],
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
      const w = reuseWorld(adopted === FROZEN ? FROZEN : { adopted });
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
  for (const base of [adoptedText, witnessedContractText]) {
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
