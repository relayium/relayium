#!/usr/bin/env node
// scripts/release/macos-evidence.mjs — the macOS release's evidence judge.
//
// Four questions, one file, because they share one trust model: GitHub's API
// says what ran, this file decides whether that is evidence, and anything it
// cannot prove is refused rather than assumed.
//
//   select            May `macos-release.yml` notarize the signed DMG that an
//                     ordinary `push` run of `macos.yml` ALREADY built for this
//                     exact commit, instead of rebuilding it? (Linux preflight.)
//   readback          Is the evidence `select` froze still exactly true, and are
//                     the downloaded bytes exactly the ones it judged? (Run on
//                     the macOS notarization runner before any secret or any
//                     restored tool is touched.)
//   frozen-candidate  Is the commit a dispatched `merge-gate.yml` run is asked
//                     to judge exactly one release-metadata commit on top of the
//                     current `main`, and nothing else? (merge-gate select job.)
//   gate-run          Did the `merge-gate.yml` run dispatched for that commit
//                     finish green, on that commit, in that attempt, with no
//                     failed lane under it? (publish job, before main moves.)
//   publish-preflight Can a publication succeed at all — protection contract,
//                     gate mode, tag state — before a paid macOS minute is spent?
//
// ## Why reuse is allowed at all
//
// Every push to `main` that touches the macOS lane's inputs runs `macos.yml`
// in full: release contract, release-script tests, BOTH product-flow UI shards
// and `signed-build`, which builds, re-signs, verifies and packages the direct
// Developer ID DMG and uploads it with its provenance. A release dispatch on
// the same commit used to call that same workflow again and get the same
// definition's bytes 15–18 minutes later. The release inputs reach only the
// contract (re-run on the notarization runner, below) and a version equality the
// provenance carries — never the build itself.
//
// ## What makes a run evidence (all of it, or nothing)
//
//   * this repository (numeric id, not name), no fork, event `push`, branch
//     `main`, workflow file `.github/workflows/macos.yml`, head SHA == the
//     commit being released;
//   * exactly ONE such run, completed and successful in its LATEST attempt,
//     created within MAX_RUN_AGE_HOURS;
//   * exactly the five expected jobs in that attempt — contract, test, both
//     ui-smoke shards and signed-build — every one completed `success`. A
//     skipped UI shard is not a pass;
//   * exactly ONE artifact named for the commit, unexpired with margin, created
//     while `signed-build` ran, whose downloaded zip hashes to the API digest
//     and holds exactly four files;
//   * provenance schema v2 binding repository id, SHA, ref, event, run id,
//     signed-build attempt, workflow ref/SHA, toolchain, channel `direct`,
//     arch `arm64`, team, app AND Share-extension version/build, and the DMG
//     and `generate_appcast` hashes — and declaring itself BUILT, not reused,
//     so reuse can never chain.
//
// ## Unavailable versus wrong
//
// `auto` (the default) falls back to the full build when evidence is merely
// UNAVAILABLE: no run, run still pending, failed or superseded by a newer
// attempt, a job missing or skipped, the artifact expired or missing, a legacy
// provenance without a schema. Rebuilding is always safe — it is the path that
// existed before this file. Evidence that EXISTS and DISAGREES — a digest that
// does not match, a payload with an extra file, a provenance naming another
// run, version or channel — is never papered over by a rebuild: it fails the
// release in every mode, because that is what tampering or a producer defect
// looks like. `reuse` turns every unavailable reason into a failure too, and
// `build` never consults the API.
//
// Node standard library only, like `scripts/ci/select-lanes.mjs`: this runs
// before anything is installed, on two runner families.

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  realpathSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { inflateRawSync } from "node:zlib";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

export const PRODUCER_WORKFLOW = ".github/workflows/macos.yml";
export const GATE_WORKFLOW = ".github/workflows/merge-gate.yml";
export const PROVENANCE_SCHEMA = "relayium-macos-signed-provenance/v2";
export const EVIDENCE_SCHEMA = "relayium-macos-reuse-evidence/v1";
export const TEAM_ID = "7PVYUG4YQS";
export const FROZEN_MODE = "frozen-release-metadata";
/** GitHub Actions' own app — the only app whose `merge-gate` may count. */
export const ACTIONS_APP_ID = 15368;

/** A week. Older than that, the runner image and the Xcode it carried are a
 *  different toolchain from the one a rebuild would use today, and the release
 *  is better served by a fresh full gate. */
export const MAX_RUN_AGE_HOURS = 168;
/** The notarization job downloads the artifact again after the preflight; it
 *  must still exist then. */
export const MIN_ARTIFACT_REMAINING_HOURS = 6;
const MAX_PAGES = 50;

/** The five jobs of a complete `macos.yml` push run, by exact name or by the
 *  matrix prefix GitHub renders (the full matrix name is truncated at 100). */
export const EXPECTED_JOBS = [
  { id: "contract", match: (name) => name === "contract" },
  { id: "test", match: (name) => name === "test" },
  { id: "ui-smoke/app-shell", match: (name) => name.startsWith("ui-smoke (app-shell, ") },
  { id: "ui-smoke/device-inbox", match: (name) => name.startsWith("ui-smoke (device-inbox, ") },
  { id: "signed-build", match: (name) => name === "signed-build" },
];
/** The sixth job a CANONICAL PR→main evidence adoption inserts, and only then. */
export const EVIDENCE_JOB = { id: "evidence", match: (name) => name === "evidence" };

/**
 * What each job must have EXECUTED, read from the API's step records — not
 * inferred from a green job name, a conclusion or a provenance boolean. Each
 * listed step must appear exactly once, `completed` / `success`. These are the
 * step names `macos.yml` gives them, and the names the jobs API reported on a
 * real `main` run (36883327742, attempt 1; kept with this revision's evidence).
 */
export const REQUIRED_STEPS = {
  contract: ["Validate release contract"],
  test: ["Toolchain versions", "Release script tests"],
  "ui-smoke/app-shell": ["Import UI signing certificate", "Install UI provisioning profiles",
    "Run macOS product-flow UI smoke (app-shell)"],
  "ui-smoke/device-inbox": ["Import UI signing certificate", "Install UI provisioning profiles",
    "Run macOS product-flow UI smoke (device-inbox)"],
  "signed-build": ["Import signing certificate", "Install provisioning profile",
    "Install Share extension provisioning profile", "Build (Mac App Store target, unsigned)",
    "Verify the App Store product embeds no updater", "Verify the App Store product ships both privacy manifests",
    "Build (signed, Release)", "Re-sign Sparkle distribution components", "Verify signature and entitlements",
    "Verify the direct product ships both privacy manifests", "Package and verify DMG",
    "Record signed package provenance", "Upload signed package artifact"],
  evidence: ["Does the merged pull request's full proof cover this main tree?"],
};
/**
 * Steps that must NOT have run. The witness path's three steps are what a
 * job runs when the merged pull request's proof is accepted INSTEAD of
 * executing it; a job that ran them did not execute the gate and is not
 * evidence for a signed build, however green it is. Under the legacy shape
 * they must not appear at all; under the canonical adoption they must be
 * reported skipped (or omitted). Each UI shard must not have run the OTHER
 * shard's suite, and the evidence job must not have kept a witness.
 */
export const WITNESS_STEPS = [
  "Check out the verifier (witness path only)",
  "Node for the verifier (witness path only)",
  "Witness — the pull request's full proof covers this job",
];
const MUST_NOT_RUN = {
  contract: WITNESS_STEPS,
  test: WITNESS_STEPS,
  "ui-smoke/app-shell": [...WITNESS_STEPS, "Run macOS product-flow UI smoke (device-inbox)"],
  "ui-smoke/device-inbox": [...WITNESS_STEPS, "Run macOS product-flow UI smoke (app-shell)"],
  "signed-build": WITNESS_STEPS,
  evidence: ["Keep the witness (reuse only)"],
};
/** Runner labels each job must report: the Apple jobs on macos-15; the
 *  ordinary push contract on Ubuntu (a release-input contract on macOS). */
const RUNNER_LABELS = {
  contract: [["ubuntu-latest"], ["macos-15"]],
  test: [["macos-15"]],
  "ui-smoke/app-shell": [["macos-15"]],
  "ui-smoke/device-inbox": [["macos-15"]],
  "signed-build": [["macos-15"]],
  evidence: [["ubuntu-latest"]],
};

/**
 * The canonical PR→main evidence adoption of `macos.yml`, as STRUCTURE: the
 * non-comment lines of the inserted job and of the three-step witness prefix,
 * exactly as `scripts/ci/ci-evidence-view.mjs` (`evidenceJobLines("macos")`,
 * `witnessStepLines("macos", false)`) writes them. Comments are ignored so an
 * edit to its prose does not turn reuse off; any structural difference does.
 * `scripts/test/macos-evidence-cases.mjs` compares these with that generator
 * whenever it is present in the tree.
 */
export const CANONICAL_EVIDENCE_JOB = [
  "  evidence:",
  "    runs-on: ubuntu-latest",
  "    timeout-minutes: 10",
  "    permissions:",
  "      contents: read",
  "      actions: read",
  "      pull-requests: read",
  "    outputs:",
  "      reuse: ${{ steps.verify.outputs.reuse }}",
  "      witness: ${{ steps.verify.outputs.witness }}",
  "    steps:",
  "      - name: Check out the verifier (ordinary main push only)",
  "        if: github.event_name == 'push' && github.ref == 'refs/heads/main'",
  "        uses: actions/checkout@de0fac2e4500dabe0009e67214ff5f5447ce83dd # v6.0.2",
  "        with:",
  "          persist-credentials: false",
  "      - name: Node for the verifier (ordinary main push only)",
  "        if: github.event_name == 'push' && github.ref == 'refs/heads/main'",
  "        uses: actions/setup-node@48b55a011bda9f5d6aeb4c2d9c7362e8dae4041e # v6.4.0",
  "        with:",
  "          node-version: 24",
  "      - name: Does the merged pull request's full proof cover this main tree?",
  "        id: verify",
  "        if: github.event_name == 'push' && github.ref == 'refs/heads/main'",
  "        env:",
  "          GH_TOKEN: ${{ github.token }}",
  "          CI_EVIDENCE_WITNESS_FILE: ${{ runner.temp }}/ci-evidence-witness/macos.json",
  "        run: node scripts/ci/ci-evidence.mjs witness macos >> \"$GITHUB_OUTPUT\"",
  "      - name: Keep the witness (reuse only)",
  "        if: steps.verify.outputs.reuse == 'true'",
  "        uses: actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a # v7.0.1",
  "        with:",
  "          name: relayium-ci-evidence-witness-macos-attempt-${{ github.run_attempt }}",
  "          path: ${{ runner.temp }}/ci-evidence-witness",
  "          if-no-files-found: error",
  "          retention-days: 30",
];
export const CANONICAL_WITNESS_STEPS = [
  "      - name: Check out the verifier (witness path only)",
  "        if: needs.evidence.outputs.reuse == 'true'",
  "        uses: actions/checkout@de0fac2e4500dabe0009e67214ff5f5447ce83dd # v6.0.2",
  "        with:",
  "          persist-credentials: false",
  "      - name: Node for the verifier (witness path only)",
  "        if: needs.evidence.outputs.reuse == 'true'",
  "        uses: actions/setup-node@48b55a011bda9f5d6aeb4c2d9c7362e8dae4041e # v6.4.0",
  "        with:",
  "          node-version: 24",
  "      - name: Witness — the pull request's full proof covers this job",
  "        if: needs.evidence.outputs.reuse == 'true'",
  "        shell: bash",
  "        env:",
  "          CI_EVIDENCE_WITNESS: ${{ needs.evidence.outputs.witness }}",
  "        run: node scripts/ci/ci-evidence.mjs confirm macos",
];
/** The jobs the canonical adoption gives the witness prefix; signed-build is `fresh`. */
const ADOPTED_JOB_IDS = ["contract", "test", "ui-smoke"];

const structural = (lines) => lines.filter((l) => l.trim() !== "" && !l.trim().startsWith("#"));

/**
 * `legacy` (no evidence adoption at all), `adopted` (exactly the canonical
 * one), or `non-canonical` (anything else that mentions the evidence path).
 * Read from `macos.yml` AT THE PRODUCER'S COMMIT, which is the definition
 * that run executed.
 */
export function workflowShape(text) {
  const mentions = /^ {2}evidence:\s*$/m.test(text) || text.includes("needs.evidence") || text.includes("ci-evidence");
  if (!mentions) return "legacy";
  const lines = text.split("\n");
  const jobsAt = lines.indexOf("jobs:");
  if (jobsAt < 0) return "non-canonical";
  // Job blocks: two-space keys under `jobs:` until the next top-level key.
  const blocks = [];
  for (let i = jobsAt + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.trim() !== "" && !line.startsWith(" ") && !line.startsWith("#")) break;
    if (/^ {2}[a-z0-9-]+:\s*$/.test(line)) blocks.push({ id: line.trim().slice(0, -1), start: i });
  }
  blocks.forEach((b, k) => { b.end = k + 1 < blocks.length ? blocks[k + 1].start : lines.length; });
  const ids = blocks.map((b) => b.id);
  if (JSON.stringify(ids) !== JSON.stringify(["evidence", "contract", "test", "ui-smoke", "signed-build"])) {
    return "non-canonical";
  }
  const body = (id) => structural(lines.slice(blocks.find((b) => b.id === id).start, blocks.find((b) => b.id === id).end));
  if (JSON.stringify(body("evidence")) !== JSON.stringify(CANONICAL_EVIDENCE_JOB)) return "non-canonical";
  const witness = JSON.stringify(CANONICAL_WITNESS_STEPS);
  for (const id of ADOPTED_JOB_IDS) {
    const b = body(id);
    const at = b.indexOf("    steps:");
    if (at < 0 || JSON.stringify(b.slice(at + 1, at + 1 + CANONICAL_WITNESS_STEPS.length)) !== witness) return "non-canonical";
    // The prefix must END where the canonical one does: the next line opens
    // the job's own first step, so no key can be appended to the witness.
    if (!/^ {6}- /.test(b[at + 1 + CANONICAL_WITNESS_STEPS.length] ?? "")) return "non-canonical";
    if (b.join("\n").split("node scripts/ci/ci-evidence.mjs confirm macos").length !== 2) return "non-canonical";
  }
  const signed = body("signed-build").join("\n");
  if (signed.includes("evidence") || signed.includes("ci-evidence")) return "non-canonical";
  return "adopted";
}

/**
 * Did this job EXECUTE its gate? Every reason it did not is `Unavailable`:
 * a full rebuild is always the safe answer to "this run did not test the
 * bytes", and an explicit `reuse` turns it into a failure.
 */
export function judgeExecution(id, job, shape) {
  const where = `job ${job.id} (${job.name})`;
  unavailable(Array.isArray(job.steps) && job.steps.length > 0, `${where} reports no step records`);
  for (const step of job.steps) {
    unavailable(step && typeof step.name === "string" && typeof step.status === "string",
      `${where} has a malformed step record`);
  }
  const labels = JSON.stringify(job.labels ?? null);
  unavailable(RUNNER_LABELS[id].some((want) => JSON.stringify(want) === labels),
    `${where} ran on ${labels}; \`${id}\` must run on ${RUNNER_LABELS[id].map((l) => JSON.stringify(l)).join(" or ")}`);
  for (const name of REQUIRED_STEPS[id]) {
    const ran = job.steps.filter((step) => step.name === name);
    unavailable(ran.length === 1, `${where} has ${ran.length} "${name}" step(s); it must execute exactly once`);
    unavailable(ran[0].status === "completed" && ran[0].conclusion === "success",
      `${where} did not execute "${name}" (${ran[0].status}/${ran[0].conclusion})`);
  }
  for (const name of MUST_NOT_RUN[id]) {
    const ran = job.steps.filter((step) => step.name === name);
    const allowed = shape === "adopted" || !WITNESS_STEPS.includes(name)
      ? ran.every((step) => step.conclusion === "skipped")
      : ran.length === 0;
    unavailable(allowed, `${where} ran "${name}" (${ran.map((s) => s.conclusion).join(", ") || "present"}); `
      + "a witnessed or foreign step is not an execution of this job's gate");
  }
}

/** Exactly these files, and nothing else, are a signed-build payload. */
export const PAYLOAD_FILES = [
  "Relayium.dmg",
  "Relayium.dmg.sha256",
  "provenance.json",
  "release-tools/generate_appcast",
];

const SHA40 = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const VERSION = /^[0-9]+(?:\.[0-9]+){1,2}$/;
const BUILD = /^[1-9][0-9]{0,8}$/;
export const CANDIDATE_REF =
  /^refs\/heads\/release-candidate\/macos-v([0-9]+(?:\.[0-9]+){1,2})-([1-9][0-9]*)-([1-9][0-9]*)$/;

/** Evidence that is absent or ineligible. `auto` may rebuild; `reuse` may not. */
export class Unavailable extends Error {}
/** Evidence that exists and is wrong. Nobody may proceed. */
export class Refused extends Error {}

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const hours = (ms) => ms / 3_600_000;

function refuse(condition, message) {
  if (!condition) throw new Refused(message);
}
function unavailable(condition, message) {
  if (!condition) throw new Unavailable(message);
}

// ── the API ─────────────────────────────────────────────────────────────────

/**
 * The real GitHub API: authenticated reads, plus one archive download.
 * `get` returns parsed JSON or throws with the status; `getOptional` maps 404
 * to `null` and nothing else.
 */
export function githubApi({ token, server = "https://api.github.com", fetchImpl = fetch } = {}) {
  if (!token) throw new Refused("no GitHub token (GH_TOKEN) is available for the evidence API");
  const headers = {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${token}`,
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "relayium-macos-evidence",
  };
  const request = async (path) => {
    const url = path.startsWith("https://") ? path : `${server}${path}`;
    return fetchImpl(url, { headers, redirect: "follow" });
  };
  return {
    async get(path) {
      const res = await request(path);
      if (!res.ok) {
        const error = new Error(`GET ${path}: HTTP ${res.status}`);
        error.status = res.status;
        throw error;
      }
      return res.json();
    },
    async getOptional(path) {
      const res = await request(path);
      if (res.status === 404) return null;
      if (!res.ok) {
        const error = new Error(`GET ${path}: HTTP ${res.status}`);
        error.status = res.status;
        throw error;
      }
      return res.json();
    },
    async download(path) {
      const res = await request(path);
      if (!res.ok) {
        const error = new Error(`GET ${path}: HTTP ${res.status}`);
        error.status = res.status;
        throw error;
      }
      return Buffer.from(await res.arrayBuffer());
    },
  };
}

/**
 * Every item of a paginated list, or an exception. The collected count must
 * equal the `total_count` the first page declared: a short read is the silent
 * truncation that would let a newer failed attempt or a duplicate artifact
 * hide on page two.
 */
export async function paginate(api, path, key) {
  const sep = path.includes("?") ? "&" : "?";
  const items = [];
  let declared = null;
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const body = await api.get(`${path}${sep}per_page=100&page=${page}`);
    if (body === null || typeof body !== "object" || !Array.isArray(body[key])) {
      throw new Refused(`${path} returned no \`${key}\` list`);
    }
    if (!Number.isInteger(body.total_count) || body.total_count < 0) {
      throw new Refused(`${path} returned no usable total_count`);
    }
    if (declared === null) declared = body.total_count;
    else if (body.total_count !== declared) {
      throw new Refused(`${path} changed its total_count from ${declared} to ${body.total_count} while being read`);
    }
    items.push(...body[key]);
    if (items.length >= declared || body[key].length === 0) break;
  }
  if (items.length !== declared) {
    throw new Refused(`${path} declared ${declared} item(s) but ${items.length} were read`);
  }
  return items;
}

// ── the producer run ────────────────────────────────────────────────────────

/** The same-repository, non-fork, push-to-main identity every candidate needs. */
function sameRepository(run, repositoryId) {
  return run?.repository?.id === repositoryId
    && run?.head_repository?.id === repositoryId
    && run?.repository?.fork === false
    && run?.head_repository?.fork !== true;
}

function workflowPathOf(run) {
  return String(run?.path ?? "").replace(/@.*$/, "");
}

/**
 * The single eligible producer run for `sha`, its latest attempt, and its
 * five jobs. Throws `Unavailable` for every reason a full rebuild is the right
 * answer, and `Refused` when the API itself contradicts what it was asked.
 */
export async function selectProducerRun(api, { repository, repositoryId, sha, now }) {
  const workflow = await api.get(`/repos/${repository}/actions/workflows/macos.yml`);
  refuse(workflow?.path === PRODUCER_WORKFLOW, `the macos workflow resolves to ${JSON.stringify(workflow?.path)}`);
  refuse(Number.isInteger(workflow?.id), "the macos workflow has no numeric id");
  unavailable(workflow.state === "active", `the macos workflow is ${workflow.state}, not active`);

  const listed = await paginate(
    api,
    `/repos/${repository}/actions/workflows/${workflow.id}/runs?event=push&branch=main&head_sha=${sha}`,
    "workflow_runs",
  );
  // The query is a filter we ASKED for; this is the filter we enforce.
  const runs = listed.filter((run) => run?.head_sha === sha
    && run?.event === "push"
    && run?.head_branch === "main"
    && run?.workflow_id === workflow.id
    && workflowPathOf(run) === PRODUCER_WORKFLOW
    && sameRepository(run, repositoryId));
  unavailable(runs.length > 0, `no push run of ${PRODUCER_WORKFLOW} on main exists for ${sha}`);
  unavailable(runs.length === 1,
    `${runs.length} push runs of ${PRODUCER_WORKFLOW} exist for ${sha}; reuse needs exactly one`);

  // Re-read the run itself: the list is a snapshot, the run is the record.
  const run = await api.get(`/repos/${repository}/actions/runs/${runs[0].id}`);
  refuse(run?.id === runs[0].id && run?.head_sha === sha && sameRepository(run, repositoryId)
    && run?.event === "push" && run?.head_branch === "main"
    && workflowPathOf(run) === PRODUCER_WORKFLOW && run?.workflow_id === workflow.id,
  `run ${runs[0].id} changed identity between the list and the record`);
  unavailable(run.status === "completed",
    `run ${run.id} is ${run.status} (attempt ${run.run_attempt}); a pending attempt is not evidence`);
  unavailable(run.conclusion === "success",
    `run ${run.id}'s latest attempt ${run.run_attempt} concluded ${run.conclusion}`);
  refuse(Number.isSafeInteger(run.run_attempt) && run.run_attempt >= 1, `run ${run.id} has no attempt number`);
  const created = Date.parse(run.created_at);
  const started = Date.parse(run.run_started_at ?? run.created_at);
  refuse(Number.isFinite(created) && Number.isFinite(started), `run ${run.id} has unreadable timestamps`);
  unavailable(hours(now - created) <= MAX_RUN_AGE_HOURS && hours(now - started) <= MAX_RUN_AGE_HOURS,
    `run ${run.id} is older than ${MAX_RUN_AGE_HOURS} hours`);

  const attempt = await api.get(`/repos/${repository}/actions/runs/${run.id}/attempts/${run.run_attempt}`);
  refuse(attempt?.id === run.id && attempt?.run_attempt === run.run_attempt && attempt?.head_sha === sha,
    `attempt ${run.run_attempt} of run ${run.id} does not describe the same run`);
  unavailable(attempt.status === "completed" && attempt.conclusion === "success",
    `attempt ${run.run_attempt} of run ${run.id} is ${attempt.status}/${attempt.conclusion}`);

  const jobs = await paginate(
    api,
    `/repos/${repository}/actions/runs/${run.id}/attempts/${run.run_attempt}/jobs`,
    "jobs",
  );
  // The definition that run executed, and therefore the job roster to expect.
  const file = await api.get(`/repos/${repository}/contents/${PRODUCER_WORKFLOW}?ref=${sha}`);
  refuse(file?.path === PRODUCER_WORKFLOW && file?.encoding === "base64" && typeof file?.content === "string",
    `the contents API did not return ${PRODUCER_WORKFLOW} at ${sha}`);
  const shape = workflowShape(Buffer.from(file.content, "base64").toString("utf8"));
  unavailable(shape !== "non-canonical",
    `${PRODUCER_WORKFLOW} at ${sha} carries a PR→main evidence adoption that is not the canonical one`);
  const expectedJobs = shape === "adopted" ? [EVIDENCE_JOB, ...EXPECTED_JOBS] : EXPECTED_JOBS;
  const byExpected = new Map(expectedJobs.map((e) => [e.id, []]));
  const strays = [];
  for (const job of jobs) {
    refuse(job?.run_id === run.id && job?.head_sha === sha,
      `job ${job?.id} listed under run ${run.id} belongs to run ${job?.run_id} / ${job?.head_sha}`);
    // Every job's own attempt is a safe positive integer no later than the
    // run's latest. NOT equal to it: a "re-run failed jobs" attempt lists the
    // jobs that already succeeded with the attempt they succeeded in. Without
    // this, a job with no attempt makes `String(undefined)` the value a forged
    // provenance has to match.
    refuse(Number.isSafeInteger(job.run_attempt) && job.run_attempt >= 1 && job.run_attempt <= run.run_attempt,
      `job ${job.id} (${job.name}) has run_attempt ${JSON.stringify(job.run_attempt)}; want an integer `
      + `from 1 to the run's latest attempt ${run.run_attempt}`);
    const expected = expectedJobs.find((e) => e.match(String(job.name ?? "")));
    if (expected) byExpected.get(expected.id).push(job);
    else strays.push(job.name);
  }
  unavailable(strays.length === 0, `run ${run.id} has unexpected jobs: ${strays.join(", ")}`);
  for (const [id, matched] of byExpected) {
    unavailable(matched.length === 1, `run ${run.id} has ${matched.length} \`${id}\` job(s); want exactly one`);
    const job = matched[0];
    unavailable(job.status === "completed" && job.conclusion === "success",
      `run ${run.id}'s \`${id}\` job is ${job.status}/${job.conclusion}; every gate job must succeed`);
    judgeExecution(id, job, shape);
  }
  return {
    workflow,
    run,
    jobs: EXPECTED_JOBS.map((e) => byExpected.get(e.id)[0]),
    shape,
    workflowBlob: file.sha,
    evidenceJob: shape === "adopted" ? byExpected.get("evidence")[0] : null,
  };
}

/** The one artifact the signed-build job uploaded, judged from metadata only. */
export async function selectArtifact(api, { repository, repositoryId, sha, run, signedBuild, now }) {
  const name = `relayium-macos-signed-${sha}-ci`;
  const all = await paginate(api, `/repos/${repository}/actions/runs/${run.id}/artifacts`, "artifacts");
  const named = all.filter((artifact) => artifact?.name === name);
  unavailable(named.length > 0, `run ${run.id} has no artifact named ${name}`);
  // Two artifacts of one name — expired or not — mean two uploads, and an
  // ambiguous one is not evidence of either.
  unavailable(named.length === 1, `run ${run.id} has ${named.length} artifacts named ${name}`);
  const artifact = named[0];
  unavailable(artifact.expired === false, `artifact ${artifact.id} has expired`);
  const expires = Date.parse(artifact.expires_at);
  unavailable(Number.isFinite(expires) && hours(expires - now) >= MIN_ARTIFACT_REMAINING_HOURS,
    `artifact ${artifact.id} expires in under ${MIN_ARTIFACT_REMAINING_HOURS} hours`);
  refuse(Number.isInteger(artifact.id), "the artifact has no numeric id");
  refuse(artifact.workflow_run?.id === run.id && artifact.workflow_run?.head_sha === sha
    && artifact.workflow_run?.repository_id === repositoryId
    && artifact.workflow_run?.head_repository_id === repositoryId,
  `artifact ${artifact.id} does not belong to run ${run.id} on ${sha}`);
  refuse(/^sha256:[0-9a-f]{64}$/.test(String(artifact.digest ?? "")),
    `artifact ${artifact.id} has no sha256 digest (${JSON.stringify(artifact.digest)})`);
  const created = Date.parse(artifact.created_at);
  const jobStart = Date.parse(signedBuild.started_at);
  const jobEnd = Date.parse(signedBuild.completed_at);
  refuse(Number.isFinite(created) && created >= jobStart && created <= jobEnd,
    `artifact ${artifact.id} was created at ${artifact.created_at}, outside signed-build `
    + `${signedBuild.started_at}..${signedBuild.completed_at}`);
  return artifact;
}

// ── the payload ─────────────────────────────────────────────────────────────

/**
 * The one directory a payload archive may name, and only as the parent of
 * `generate_appcast`. `upload-artifact` writes no directory entries at all
 * today; a canonical one is tolerated so a future archiver that adds it is not
 * mistaken for tampering, and nothing else is.
 */
export const PAYLOAD_DIRECTORY = "release-tools/";
const MAX_PAYLOAD_BYTES = 2 * 1024 * 1024 * 1024;
const S_IFMT = 0o170000;
const S_IFREG = 0o100000;
const S_IFDIR = 0o040000;
const HOST_UNIX = 3;

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();
export function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/**
 * Why a raw entry name is not a plain relative path, or null when it is.
 * Checked on the BYTES, before any decoding or normalization could hide them.
 */
export function unsafeNameReason(raw) {
  if (raw.length === 0) return "an empty name";
  if (raw.includes(0)) return "a NUL byte";
  if (raw.includes(0x5c)) return "a backslash";
  for (const byte of raw) {
    if (byte < 0x20 || byte > 0x7e) return `a non-printable or non-ASCII byte 0x${byte.toString(16)}`;
  }
  const name = raw.toString("latin1");
  if (name.startsWith("/") || /^[A-Za-z]:/.test(name)) return "an absolute path";
  const segments = (name.endsWith("/") ? name.slice(0, -1) : name).split("/");
  if (segments.some((seg) => seg === ".." || seg === ".")) return "a traversal segment";
  if (segments.some((seg) => seg === "")) return "an empty path segment";
  return null;
}

/**
 * Every entry of a ZIP archive, read from its central directory and checked
 * against its local header, with each member's bytes decompressed and
 * CRC-checked in memory. Nothing is extracted and no external `unzip` is
 * involved, so no name is ever interpreted by a filesystem here.
 *
 * Refused: a malformed or trailing-garbage archive, multi-disk and ZIP64
 * archives, encryption, any method but stored/deflate, a local header that
 * disagrees with the central one, overlapping member data, a size or CRC that
 * does not match, and more than MAX_PAYLOAD_BYTES of output.
 */
export function readZipEntries(zip) {
  refuse(Buffer.isBuffer(zip) && zip.length >= 22, "the artifact archive is too short to be a zip");
  let eocd = -1;
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 22 - 0xffff); i -= 1) {
    if (zip.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  refuse(eocd >= 0, "the artifact archive has no end-of-central-directory record");
  refuse(!(eocd >= 20 && zip.readUInt32LE(eocd - 20) === 0x07064b50), "ZIP64 archives are not accepted");
  const disk = zip.readUInt16LE(eocd + 4);
  const cdDisk = zip.readUInt16LE(eocd + 6);
  const onDisk = zip.readUInt16LE(eocd + 8);
  const total = zip.readUInt16LE(eocd + 10);
  const cdSize = zip.readUInt32LE(eocd + 12);
  const cdOffset = zip.readUInt32LE(eocd + 16);
  const commentLength = zip.readUInt16LE(eocd + 20);
  refuse(disk === 0 && cdDisk === 0 && onDisk === total, "multi-disk archives are not accepted");
  refuse(total !== 0xffff && cdSize !== 0xffffffff && cdOffset !== 0xffffffff, "ZIP64 archives are not accepted");
  refuse(eocd + 22 + commentLength === zip.length, "the artifact archive has bytes after its end record");
  refuse(cdOffset + cdSize === eocd, "the central directory does not end where the end record begins");

  const entries = [];
  const ranges = [];
  let produced = 0;
  let at = cdOffset;
  for (let n = 0; n < total; n += 1) {
    refuse(at + 46 <= eocd && zip.readUInt32LE(at) === 0x02014b50, `central directory entry ${n} is malformed`);
    const madeBy = zip.readUInt16LE(at + 4);
    const flags = zip.readUInt16LE(at + 8);
    const method = zip.readUInt16LE(at + 10);
    const crc = zip.readUInt32LE(at + 16);
    const csize = zip.readUInt32LE(at + 20);
    const usize = zip.readUInt32LE(at + 24);
    const nameLength = zip.readUInt16LE(at + 28);
    const extraLength = zip.readUInt16LE(at + 30);
    const entryCommentLength = zip.readUInt16LE(at + 32);
    const diskStart = zip.readUInt16LE(at + 34);
    const external = zip.readUInt32LE(at + 38);
    const local = zip.readUInt32LE(at + 42);
    const end = at + 46 + nameLength + extraLength + entryCommentLength;
    refuse(end <= eocd, `central directory entry ${n} overruns the directory`);
    const raw = zip.subarray(at + 46, at + 46 + nameLength);
    refuse(diskStart === 0, `entry ${n} starts on another disk`);
    refuse((flags & 0x1) === 0 && (flags & 0x40) === 0, `entry ${n} is encrypted`);
    refuse(method === 0 || method === 8, `entry ${n} uses unsupported compression method ${method}`);
    refuse(csize !== 0xffffffff && usize !== 0xffffffff && local !== 0xffffffff, "ZIP64 archives are not accepted");

    refuse(local + 30 <= cdOffset && zip.readUInt32LE(local) === 0x04034b50, `entry ${n} has no local header`);
    const localNameLength = zip.readUInt16LE(local + 26);
    const localExtraLength = zip.readUInt16LE(local + 28);
    refuse(zip.readUInt16LE(local + 8) === method, `entry ${n}'s local header names another method`);
    refuse(localNameLength === nameLength
      && zip.subarray(local + 30, local + 30 + localNameLength).equals(raw),
    `entry ${n}'s local header names another file`);
    const dataStart = local + 30 + localNameLength + localExtraLength;
    const dataEnd = dataStart + csize;
    refuse(dataEnd <= cdOffset, `entry ${n}'s data overruns the archive`);
    ranges.push([local, dataEnd, n]);

    produced += usize;
    refuse(produced <= MAX_PAYLOAD_BYTES, "the artifact archive expands beyond the payload bound");
    const compressed = zip.subarray(dataStart, dataEnd);
    let data;
    if (method === 0) {
      refuse(csize === usize, `stored entry ${n} declares different sizes`);
      data = Buffer.from(compressed);
    } else {
      try {
        data = inflateRawSync(compressed, { maxOutputLength: Math.max(usize, 1) });
      } catch (error) {
        throw new Refused(`entry ${n} does not inflate: ${error.message}`);
      }
    }
    refuse(data.length === usize, `entry ${n} inflates to ${data.length} bytes, not ${usize}`);
    refuse(crc32(data) === crc, `entry ${n} fails its CRC`);

    const host = madeBy >>> 8;
    const mode = host === HOST_UNIX ? external >>> 16 : null;
    entries.push({ raw, name: raw.toString("latin1"), host, mode, dosAttributes: external & 0xff, data });
    at = end;
  }
  refuse(at === eocd, "the central directory holds bytes beyond its declared entries");
  ranges.sort((a, b) => a[0] - b[0]);
  for (let i = 1; i < ranges.length; i += 1) {
    refuse(ranges[i][0] >= ranges[i - 1][1], `entries ${ranges[i - 1][2]} and ${ranges[i][2]} overlap`);
  }
  return entries;
}

/** What kind of filesystem object an entry would create. */
function entryKind(entry) {
  if (entry.mode !== null) {
    const type = entry.mode & S_IFMT;
    if (type === S_IFREG) return "file";
    if (type === S_IFDIR) return "directory";
    if (type === 0o120000) return "symlink";
    if (type === 0) return entry.name.endsWith("/") ? "directory" : "untyped";
    return `special (mode ${entry.mode.toString(8)})`;
  }
  return entry.dosAttributes & 0x10 || entry.name.endsWith("/") ? "directory" : "file";
}

/**
 * The four payload files of a signed-build archive, in memory, or a refusal
 * naming the first entry that is anything else: an unsafe name, a duplicate, a
 * symlink or other non-regular member, a directory other than the canonical
 * `release-tools/`, an unexpected file, or a missing one.
 */
export function readPayloadArchive(zip) {
  const entries = readZipEntries(zip);
  const files = new Map();
  const seen = new Set();
  for (const entry of entries) {
    const unsafe = unsafeNameReason(entry.raw);
    refuse(unsafe === null, `the artifact names ${JSON.stringify(entry.name)}, which contains ${unsafe}`);
    refuse(!seen.has(entry.name), `the artifact names ${entry.name} twice`);
    seen.add(entry.name);
    const kind = entryKind(entry);
    if (entry.name.endsWith("/")) {
      refuse(entry.name === PAYLOAD_DIRECTORY,
        `the artifact holds directory ${entry.name}; only ${PAYLOAD_DIRECTORY} may appear`);
      refuse(kind === "directory", `the artifact's ${entry.name} is a ${kind}, not a directory`);
      refuse(entry.data.length === 0, `the artifact's ${entry.name} carries data`);
      continue;
    }
    refuse(kind === "file", `the artifact's ${entry.name} is a ${kind}, not a regular file`);
    refuse(PAYLOAD_FILES.includes(entry.name),
      `the artifact holds ${entry.name}; want exactly [${PAYLOAD_FILES.join(", ")}]`);
    files.set(entry.name, entry.data);
  }
  const missing = PAYLOAD_FILES.filter((file) => !files.has(file));
  refuse(missing.length === 0, `the artifact lacks ${missing.join(", ")}`);
  return files;
}

/**
 * Write the verified payload into `dir`, never through anything already there.
 *
 * `dir` is either absent — then it is created, non-recursively, mode 0700, as
 * the fresh isolated directory — or an existing REAL directory (not a symlink)
 * in which none of the five payload paths exists yet, symlinks included.
 * Each file is created with O_CREAT|O_EXCL|O_NOFOLLOW, so a target that
 * appeared in between fails rather than being followed. Every written file is
 * then reopened with O_NOFOLLOW, required to be a regular single-link file of
 * the right size, and hashed from disk; those on-disk hashes are what the
 * evidence records.
 */
export function installPayload(files, dir) {
  let created = false;
  let stat = null;
  try {
    stat = lstatSync(dir);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  if (stat === null) {
    mkdirSync(dir, { mode: 0o700 });
    created = true;
  } else {
    refuse(stat.isDirectory() && !stat.isSymbolicLink(), `${dir} exists and is not a real directory`);
  }
  if (!created) {
    for (const path of [...PAYLOAD_FILES, PAYLOAD_DIRECTORY.slice(0, -1)]) {
      let existing = null;
      try {
        existing = lstatSync(join(dir, path));
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      refuse(existing === null,
        `${join(dir, path)} already exists (${existing?.isSymbolicLink() ? "a symlink" : "a file or directory"}); `
        + "the payload is never written over or through a preexisting path");
    }
  }
  mkdirSync(join(dir, PAYLOAD_DIRECTORY), { mode: 0o700 });
  const flags = fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW;
  for (const [file, data] of files) {
    const fd = openSync(join(dir, file), flags, 0o600);
    try {
      let offset = 0;
      while (offset < data.length) offset += writeSync(fd, data, offset, data.length - offset);
    } finally {
      closeSync(fd);
    }
  }
  return hashPayload(dir, files);
}

/**
 * Hash every payload file from disk through an O_NOFOLLOW descriptor, after
 * lstat proves each is a regular, single-link file — never through a symlink,
 * a directory or a device. With `expected`, the bytes must also be exactly
 * the ones that were verified in memory.
 */
export function hashPayload(dir, expected = null) {
  const out = {};
  for (const file of PAYLOAD_FILES) {
    const path = join(dir, file);
    let stat;
    try {
      stat = lstatSync(path);
    } catch {
      throw new Refused(`the payload has no ${file}`);
    }
    refuse(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1,
      `the payload's ${file} is not a regular single-link file`);
    const fd = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    let bytes;
    try {
      const fstat = fstatSync(fd);
      refuse(fstat.isFile() && fstat.ino === stat.ino && fstat.dev === stat.dev,
        `the payload's ${file} changed identity while it was opened`);
      bytes = readFileSync(fd);
    } finally {
      closeSync(fd);
    }
    if (expected) {
      refuse(bytes.equals(expected.get(file)), `the payload's ${file} on disk is not the verified bytes`);
    }
    out[file] = sha256(bytes);
  }
  return out;
}

function requireString(object, key, where) {
  const value = object?.[key];
  refuse(typeof value === "string" && value.trim() !== "", `${where}.${key} is missing or empty`);
  return value;
}

/**
 * The provenance contract. `expect` holds what the API proved; every field
 * that can be compared to it is.
 */
export function judgeProvenance(provenance, payloadHashes, checksumText, expect) {
  refuse(provenance !== null && typeof provenance === "object" && !Array.isArray(provenance),
    "provenance.json is not an object");
  unavailable(provenance.schema !== undefined,
    "provenance.json predates the v2 schema (legacy producer); it cannot bind its run");
  refuse(provenance.schema === PROVENANCE_SCHEMA,
    `provenance schema is ${JSON.stringify(provenance.schema)}, want ${PROVENANCE_SCHEMA}`);
  const p = provenance;
  const exact = (key, want) => refuse(p[key] === want,
    `provenance.${key} is ${JSON.stringify(p[key])}, want ${JSON.stringify(want)}`);
  exact("repository", expect.repository);
  exact("repositoryId", String(expect.repositoryId));
  exact("sha", expect.sha);
  exact("ref", "refs/heads/main");
  exact("event", "push");
  exact("runId", String(expect.runId));
  exact("runAttempt", String(expect.signedBuildAttempt));
  exact("workflowRef", `${expect.repository}/${PRODUCER_WORKFLOW}@refs/heads/main`);
  exact("workflowSha", expect.sha);
  exact("channel", "direct");
  exact("arch", "arm64");
  exact("teamId", TEAM_ID);
  // Reuse never chains: only a build may be reused.
  exact("signedBuildSource", "built");
  exact("releaseVersion", "");
  const version = requireString(p, "version", "provenance");
  const build = requireString(p, "build", "provenance");
  refuse(VERSION.test(version), `provenance.version ${JSON.stringify(version)} is not a version`);
  refuse(BUILD.test(build), `provenance.build ${JSON.stringify(build)} is not a build number`);
  exact("shareExtensionVersion", version);
  exact("shareExtensionBuild", build);
  if (expect.releaseVersion) {
    refuse(version === expect.releaseVersion,
      `the reusable build is version ${version}, not the requested release ${expect.releaseVersion}`);
  }
  const toolchain = p.toolchain;
  refuse(toolchain && typeof toolchain === "object", "provenance.toolchain is missing");
  for (const key of ["xcode", "swift", "macos", "runnerImage"]) requireString(toolchain, key, "provenance.toolchain");
  exact("dmgSha256", payloadHashes["Relayium.dmg"]);
  exact("signedDmgSha256", payloadHashes["Relayium.dmg"]);
  exact("generateAppcastSha256", payloadHashes["release-tools/generate_appcast"]);
  // Byte-exact: `package-dmg.sh` writes `<hash>  Relayium.dmg\n` and nothing else.
  refuse(checksumText === `${payloadHashes["Relayium.dmg"]}  Relayium.dmg\n`,
    "Relayium.dmg.sha256 is not exactly the payload DMG's checksum line");
  return { version, build };
}

/**
 * Everything `select` proves, end to end. `dir` receives the extracted bytes.
 * Returns the frozen evidence document.
 */
export async function collectEvidence(api, { repository, repositoryId, sha, releaseVersion, now, dir }) {
  const { workflow, run, jobs, shape, workflowBlob, evidenceJob } =
    await selectProducerRun(api, { repository, repositoryId, sha, now });
  const signedBuild = jobs[EXPECTED_JOBS.findIndex((e) => e.id === "signed-build")];
  const artifact = await selectArtifact(api, { repository, repositoryId, sha, run, signedBuild, now });
  let zip;
  try {
    zip = await api.download(`/repos/${repository}/actions/artifacts/${artifact.id}/zip`);
  } catch (error) {
    if (error?.status === 404 || error?.status === 410) {
      throw new Unavailable(`artifact ${artifact.id} could not be downloaded (HTTP ${error.status})`);
    }
    throw error;
  }
  const zipHash = sha256(zip);
  refuse(`sha256:${zipHash}` === artifact.digest,
    `artifact ${artifact.id} downloaded as sha256:${zipHash}, but the API digest is ${artifact.digest}`);
  // Judged entirely in memory, then written once — exclusively, never
  // through an existing path — and re-hashed from disk. The provenance and
  // checksum text are read from those same verified bytes, not reopened.
  const files = readPayloadArchive(zip);
  const hashes = installPayload(files, dir ?? mkdtempSync(join(tmpdir(), "macos-evidence-payload-")) + "/payload");
  let provenance;
  try {
    provenance = JSON.parse(files.get("provenance.json").toString("utf8"));
  } catch (error) {
    throw new Refused(`provenance.json is not JSON: ${error.message}`);
  }
  const { version, build } = judgeProvenance(
    provenance,
    hashes,
    files.get("Relayium.dmg.sha256").toString("utf8"),
    {
      repository,
      repositoryId,
      sha,
      runId: run.id,
      signedBuildAttempt: signedBuild.run_attempt,
      releaseVersion,
    },
  );
  return {
    schema: EVIDENCE_SCHEMA,
    repository,
    repositoryId,
    sha,
    workflow: { id: workflow.id, path: workflow.path, shape, blob: workflowBlob },
    run: {
      id: run.id,
      attempt: run.run_attempt,
      event: run.event,
      headBranch: run.head_branch,
      conclusion: run.conclusion,
      createdAt: run.created_at,
      runStartedAt: run.run_started_at ?? null,
    },
    jobs: [...jobs, ...(evidenceJob ? [evidenceJob] : [])].map((job) => ({
      id: job.id,
      name: job.name,
      conclusion: job.conclusion,
      runAttempt: job.run_attempt,
      startedAt: job.started_at,
      completedAt: job.completed_at,
    })),
    artifact: {
      id: artifact.id,
      name: artifact.name,
      digest: artifact.digest,
      sizeInBytes: artifact.size_in_bytes ?? null,
      createdAt: artifact.created_at,
      expiresAt: artifact.expires_at,
    },
    files: hashes,
    version,
    build,
    toolchain: provenance.toolchain,
  };
}

/** The subset of the evidence that must not change between preflight and use. */
export function evidenceIdentity(evidence) {
  return JSON.stringify({
    schema: evidence.schema,
    repository: evidence.repository,
    repositoryId: evidence.repositoryId,
    sha: evidence.sha,
    workflow: evidence.workflow,
    run: { id: evidence.run.id, attempt: evidence.run.attempt, conclusion: evidence.run.conclusion },
    jobs: evidence.jobs.map((j) => [j.id, j.conclusion, j.runAttempt]),
    artifact: { id: evidence.artifact.id, name: evidence.artifact.name, digest: evidence.artifact.digest },
    files: evidence.files,
    version: evidence.version,
    build: evidence.build,
  });
}

/**
 * The preflight decision. Returns `{ source, reason, evidence }` where source
 * is `reuse` or `build`; throws `Refused` (and, in `reuse` mode, a converted
 * `Unavailable`) to stop the release.
 */
export async function decide(api, { mode, repository, repositoryId, sha, ref, releaseVersion, now, dir }) {
  refuse(["auto", "reuse", "build"].includes(mode),
    `signed_build_source is ${JSON.stringify(mode)}; want auto, reuse or build`);
  refuse(SHA40.test(sha), `the release commit ${JSON.stringify(sha)} is not a full SHA`);
  refuse(Number.isInteger(repositoryId) && repositoryId > 0, "the repository id is missing");
  if (mode === "build") return { source: "build", reason: "the operator asked for a full build", evidence: null };
  try {
    unavailable(ref === "refs/heads/main", `the release runs from ${ref}, not main; only main is ever reused`);
    const evidence = await collectEvidence(api, { repository, repositoryId, sha, releaseVersion, now, dir });
    return { source: "reuse", reason: `run ${evidence.run.id} attempt ${evidence.run.attempt}`, evidence };
  } catch (error) {
    if (error instanceof Unavailable) {
      if (mode === "reuse") throw new Refused(`reuse was required, but ${error.message}`);
      return { source: "build", reason: error.message, evidence: null };
    }
    throw error;
  }
}

/**
 * The fresh readback. Re-proves everything from the API into `dir` and
 * requires the result to be IDENTICAL to what the preflight froze. Any change
 * — a newer attempt, a different artifact, different bytes — is refused, even
 * an "unavailable" one: a release committed to reuse must not quietly become
 * something else halfway through.
 */
export async function readback(api, frozen, { now, dir, releaseVersion }) {
  refuse(frozen?.schema === EVIDENCE_SCHEMA, "the frozen evidence is not a reuse evidence document");
  let fresh;
  try {
    fresh = await collectEvidence(api, {
      repository: frozen.repository,
      repositoryId: frozen.repositoryId,
      sha: frozen.sha,
      releaseVersion,
      now,
      dir,
    });
  } catch (error) {
    if (error instanceof Unavailable) throw new Refused(`the frozen evidence no longer holds: ${error.message}`);
    throw error;
  }
  refuse(evidenceIdentity(fresh) === evidenceIdentity(frozen),
    "the evidence read back now differs from the evidence the preflight froze");
  return fresh;
}

// ── the frozen release-metadata candidate ───────────────────────────────────

function git(args, cwd) {
  const out = spawnSync("git", args, { cwd, encoding: "buffer", maxBuffer: 64 * 1024 * 1024 });
  refuse(out.status === 0, `git ${args.join(" ")} failed: ${out.stderr?.toString()}`);
  return out.stdout;
}

/**
 * Every path the commit touches, with renames and copies split into BOTH
 * sides. `--no-renames` is what makes a rename two records — the old path as a
 * deletion and the new one as an addition — so a move out of a selected tree
 * still selects it and still meets the scope check.
 */
export function changedPaths(base, head, cwd) {
  const raw = git(["diff-tree", "-r", "-z", "--no-commit-id", "--no-renames", "--name-status", base, head], cwd)
    .toString("utf8");
  const fields = raw.split("\0").filter((f) => f !== "");
  refuse(fields.length % 2 === 0, "git diff-tree produced an odd record stream");
  const entries = [];
  for (let i = 0; i < fields.length; i += 2) {
    const status = fields[i];
    const path = fields[i + 1];
    refuse(/^[ADMT]$/.test(status), `unexpected change status ${status} for ${path}`);
    entries.push({ status, path });
  }
  return entries;
}

const STATUS_WORD = { A: "added", D: "removed", M: "modified", T: "changed" };

/**
 * merge-gate's strict dispatch mode. Every condition is a hard stop: unlike the
 * pull-request selector, which widens to every lane on doubt, a frozen release
 * candidate that is not exactly what it claims to be must not be judged at all.
 */
export async function judgeFrozenCandidate(api, env, { cwd, judgeRoot }) {
  refuse(env.GITHUB_EVENT_NAME === "workflow_dispatch", "the frozen mode is reachable only by workflow_dispatch");
  refuse(env.MODE === FROZEN_MODE, `mode is ${JSON.stringify(env.MODE)}, not ${FROZEN_MODE}`);
  const ref = env.GITHUB_REF ?? "";
  const match = CANDIDATE_REF.exec(ref);
  refuse(match !== null, `ref ${JSON.stringify(ref)} is not a release-candidate/macos-v<version>-<run>-<attempt> branch`);
  const base = env.EXPECTED_BASE ?? "";
  const head = env.EXPECTED_HEAD ?? "";
  refuse(SHA40.test(base) && SHA40.test(head), "base_sha and head_sha must be full lowercase SHAs");
  refuse(base !== head, "base_sha and head_sha are the same commit");
  refuse(env.GITHUB_SHA === head, `this run checked out ${env.GITHUB_SHA}, not head_sha ${head}`);
  refuse(git(["rev-parse", "HEAD"], cwd).toString().trim() === head,
    "the working tree is not the dispatched head commit");

  const repository = env.GITHUB_REPOSITORY;
  const main = await api.get(`/repos/${repository}/git/ref/heads/main`);
  refuse(main?.object?.sha === base, `main is ${main?.object?.sha}, not base_sha ${base}; the candidate is stale`);
  const branch = await api.get(`/repos/${repository}/git/ref/${ref.replace(/^refs\//, "")}`);
  refuse(branch?.object?.sha === head, `${ref} now points at ${branch?.object?.sha}, not head_sha ${head}`);

  const header = git(["cat-file", "commit", head], cwd).toString("utf8").split("\n\n")[0];
  const parents = header.split("\n").filter((line) => line.startsWith("parent ")).map((line) => line.slice(7));
  refuse(parents.length === 1 && parents[0] === base,
    `the candidate has parents [${parents.join(", ")}]; want exactly [${base}]`);

  const entries = changedPaths(base, head, cwd);
  refuse(entries.length > 0, "the candidate changes nothing");
  const paths = [...new Set(entries.map((e) => e.path))];
  const scopeModule = await import(pathToFileURL(join(judgeRoot, "web/scripts/macos-release-candidate.mjs")).href);
  const scope = scopeModule.checkCandidateScope(paths, { alreadyDelivered: false });
  refuse(scope.ok, `the candidate is not exactly one release-metadata commit: ${scope.problems.join("; ")}`);

  let manifest;
  try {
    manifest = JSON.parse(git(["show", `${head}:web/native-releases.json`], cwd).toString("utf8"));
  } catch (error) {
    throw new Refused(`the candidate's web/native-releases.json is unreadable: ${error.message}`);
  }
  refuse(manifest?.macos?.version === match[1],
    `the candidate publishes macOS ${manifest?.macos?.version}, but its branch names ${match[1]}`);

  return {
    version: match[1],
    entries,
    payload: entries.map((e) => ({ filename: e.path, status: STATUS_WORD[e.status] })),
  };
}

// ── the dispatched gate run ─────────────────────────────────────────────────

const BAD_CONCLUSIONS = new Set(["failure", "cancelled", "timed_out", "action_required", "startup_failure", "stale", "neutral"]);

/** The one merge-gate run dispatched on `branch` at `head` since `since`. */
export async function findGateRun(api, { repository, repositoryId, branch, head, since }) {
  const workflow = await api.get(`/repos/${repository}/actions/workflows/merge-gate.yml`);
  refuse(workflow?.path === GATE_WORKFLOW && workflow?.state === "active", "merge-gate.yml is not an active workflow");
  const listed = await paginate(
    api,
    `/repos/${repository}/actions/workflows/${workflow.id}/runs?event=workflow_dispatch&branch=${encodeURIComponent(branch)}&head_sha=${head}`,
    "workflow_runs",
  );
  const sinceMs = Date.parse(since) - 120_000;
  const runs = listed.filter((run) => run?.head_sha === head && run?.head_branch === branch
    && run?.event === "workflow_dispatch" && workflowPathOf(run) === GATE_WORKFLOW
    && run?.workflow_id === workflow.id && sameRepository(run, repositoryId)
    && Date.parse(run.created_at) >= sinceMs);
  if (runs.length === 0) return null;
  refuse(runs.length === 1, `${runs.length} merge-gate runs were dispatched for ${head}; expected exactly one`);
  return { id: runs[0].id, attempt: runs[0].run_attempt };
}

/**
 * The finished gate, re-read as a record: same run, same attempt, same head,
 * success, a `merge-gate` job that succeeded, and no job anywhere in that
 * attempt that failed — so an aggregate that wrongly reported green over a red
 * lane still cannot move main.
 */
export async function judgeGateRun(api, { repository, repositoryId, branch, head, runId, attempt }) {
  const run = await api.get(`/repos/${repository}/actions/runs/${runId}`);
  refuse(run?.id === runId && run?.head_sha === head && run?.head_branch === branch
    && run?.event === "workflow_dispatch" && workflowPathOf(run) === GATE_WORKFLOW
    && sameRepository(run, repositoryId), `merge-gate run ${runId} is not the dispatched candidate gate`);
  refuse(run.run_attempt === attempt, `merge-gate run ${runId} is now attempt ${run.run_attempt}, not ${attempt}`);
  refuse(run.status === "completed" && run.conclusion === "success",
    `merge-gate run ${runId} is ${run.status}/${run.conclusion}`);
  const jobs = await paginate(api, `/repos/${repository}/actions/runs/${runId}/attempts/${attempt}/jobs`, "jobs");
  const aggregate = jobs.filter((job) => job?.name === "merge-gate");
  refuse(aggregate.length === 1, `merge-gate run ${runId} has ${aggregate.length} aggregate jobs`);
  refuse(aggregate[0].status === "completed" && aggregate[0].conclusion === "success",
    `the aggregate job is ${aggregate[0].status}/${aggregate[0].conclusion}`);
  const select = jobs.filter((job) => job?.name === "select");
  refuse(select.length === 1 && select[0].conclusion === "success", "the selector job did not succeed");
  for (const job of jobs) {
    refuse(job?.run_id === runId && job?.head_sha === head, `job ${job?.id} does not belong to run ${runId}`);
    refuse(job.status === "completed", `job ${job.name} is ${job.status}`);
    refuse(!BAD_CONCLUSIONS.has(job.conclusion), `job ${job.name} concluded ${job.conclusion}`);
    refuse(job.conclusion === "success" || job.conclusion === "skipped",
      `job ${job.name} concluded ${job.conclusion}`);
  }
  return { runId, attempt, jobs: jobs.length };
}

// ── the publication preflight ───────────────────────────────────────────────

/**
 * What can be known, read-only, before the paid build starts. The token's
 * dispatch and push permissions cannot be proven without using them; what can
 * be proven is that the protection contract is the one this delivery path is
 * built for, that the gate on main understands the frozen mode, and that the
 * tag is free or already this release.
 */
export async function publishPreflight(api, { repository, sha, ref, releaseVersion, notarize }) {
  refuse(ref === "refs/heads/main", `publication runs from ${ref}; it must run from main`);
  refuse(VERSION.test(releaseVersion ?? ""), `release_version ${JSON.stringify(releaseVersion)} is not a version`);
  refuse(notarize === "true", "publication requires notarize=true");
  const branch = await api.get(`/repos/${repository}/branches/main`);
  refuse(branch?.protected === true, "main is not protected; the frozen delivery path assumes it is");
  const checks = branch?.protection?.required_status_checks;
  const contexts = [...(checks?.contexts ?? [])].sort();
  refuse(JSON.stringify(contexts) === JSON.stringify(["merge-gate"]),
    `main requires [${contexts.join(", ")}]; the delivery path satisfies exactly [merge-gate]`);
  const bound = (checks?.checks ?? []).filter((c) => c?.context === "merge-gate");
  refuse(bound.length === 1 && bound[0].app_id === ACTIONS_APP_ID,
    "the required merge-gate context is not bound to GitHub Actions");
  const gate = await api.get(`/repos/${repository}/actions/workflows/merge-gate.yml`);
  refuse(gate?.state === "active", "merge-gate.yml is not active, so the candidate cannot be judged");
  const file = await api.get(`/repos/${repository}/contents/.github/workflows/merge-gate.yml?ref=main`);
  const text = Buffer.from(String(file?.content ?? ""), "base64").toString("utf8");
  refuse(text.includes(FROZEN_MODE), `main's merge-gate.yml has no ${FROZEN_MODE} mode to dispatch`);
  const compare = await api.get(`/repos/${repository}/compare/${sha}...main`);
  refuse(compare?.behind_by === 0 && ["ahead", "identical"].includes(compare?.status),
    `${sha} is not an ancestor of main (${compare?.status}); the candidate cannot extend main`);
  const tag = await api.getOptional(`/repos/${repository}/git/ref/tags/macos-v${releaseVersion}`);
  if (tag !== null) {
    // A rerun after a publication: allowed only when the tag is THIS commit.
    let target = tag?.object?.sha;
    if (tag?.object?.type === "tag") {
      const annotated = await api.get(`/repos/${repository}/git/tags/${target}`);
      target = annotated?.object?.sha;
    }
    refuse(target === sha, `macos-v${releaseVersion} already exists at ${target}, not ${sha}`);
  }
  return { tagExists: tag !== null };
}

// ── the command ─────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i];
    const value = argv[i + 1];
    if (!key?.startsWith("--") || value === undefined) throw new Refused(`expected --flag value pairs, got ${key}`);
    out[key.slice(2)] = value;
  }
  return out;
}

function outputLines(lines, file) {
  const text = `${lines.join("\n")}\n`;
  if (file) writeFileSync(file, text, { flag: "a" });
  else process.stdout.write(text);
}

function repositoryIdFromEnv(env) {
  const id = Number(env.GITHUB_REPOSITORY_ID);
  refuse(Number.isInteger(id) && id > 0, "GITHUB_REPOSITORY_ID is not set");
  return id;
}

export async function main(
  argv,
  env = process.env,
  apiFactory = () => githubApi({ token: env.GH_TOKEN, server: env.GITHUB_API_URL || undefined }),
) {
  const [command, ...rest] = argv;
  const args = parseArgs(rest);
  const now = args.now ? Date.parse(args.now) : Date.now();

  if (command === "select") {
    const api = apiFactory();
    const decision = await decide(api, {
      mode: args.mode,
      repository: env.GITHUB_REPOSITORY,
      repositoryId: repositoryIdFromEnv(env),
      sha: env.GITHUB_SHA,
      ref: env.GITHUB_REF,
      releaseVersion: args["release-version"] ?? "",
      now,
      dir: resolve(args.dir),
    });
    const record = {
      decidedAt: new Date(now).toISOString(),
      mode: args.mode,
      source: decision.source,
      reason: decision.reason,
      evidence: decision.evidence,
    };
    writeFileSync(resolve(args.record), `${JSON.stringify(record, null, 2)}\n`);
    process.stderr.write(`signed build source: ${decision.source} (${decision.reason})\n`);
    outputLines([
      `source=${decision.source}`,
      `evidence=${decision.evidence ? JSON.stringify(decision.evidence) : ""}`,
    ], args.output);
    return 0;
  }

  if (command === "readback") {
    const api = apiFactory();
    let frozen;
    try {
      frozen = JSON.parse(env.REUSE_EVIDENCE ?? "");
    } catch {
      throw new Refused("REUSE_EVIDENCE is not the frozen evidence JSON");
    }
    refuse(frozen.sha === env.GITHUB_SHA && frozen.repository === env.GITHUB_REPOSITORY
      && frozen.repositoryId === repositoryIdFromEnv(env), "the frozen evidence names another commit or repository");
    const fresh = await readback(api, frozen, { now, dir: resolve(args.dir), releaseVersion: args["release-version"] ?? "" });
    writeFileSync(resolve(args.record), `${JSON.stringify({ readAt: new Date(now).toISOString(), evidence: fresh }, null, 2)}\n`);
    process.stderr.write(`reuse evidence re-proven: run ${fresh.run.id} attempt ${fresh.run.attempt}, artifact ${fresh.artifact.id}\n`);
    process.stdout.write(`readback-verified ${fresh.artifact.id}\n`);
    return 0;
  }

  if (command === "frozen-candidate") {
    const api = apiFactory();
    const judged = await judgeFrozenCandidate(api, env, { cwd: process.cwd(), judgeRoot: resolve(args["judge-root"]) });
    writeFileSync(resolve(args.payload), `${JSON.stringify(judged.payload)}\n`);
    process.stderr.write(`frozen release-metadata candidate for macOS ${judged.version}: ${judged.payload.length} path(s)\n`);
    outputLines([
      `payload=${resolve(args.payload)}`,
      "status=ok",
      `changed_files=${judged.payload.length}`,
    ], args.output);
    return 0;
  }

  if (command === "gate-run") {
    const api = apiFactory();
    const common = {
      repository: env.GITHUB_REPOSITORY,
      repositoryId: repositoryIdFromEnv(env),
      branch: args.branch,
      head: args.head,
    };
    if (args.action === "find") {
      const found = await findGateRun(api, { ...common, since: args.since });
      if (found === null) return 3;
      process.stdout.write(`${found.id} ${found.attempt}\n`);
      return 0;
    }
    refuse(args.action === "verify", "gate-run --action must be find or verify");
    const judged = await judgeGateRun(api, { ...common, runId: Number(args.run), attempt: Number(args.attempt) });
    process.stderr.write(`merge-gate run ${judged.runId} attempt ${judged.attempt}: ${judged.jobs} job(s), all green\n`);
    process.stdout.write(`merge-gate-verified ${judged.runId} ${judged.attempt}\n`);
    return 0;
  }

  if (command === "publish-preflight") {
    const api = apiFactory();
    const result = await publishPreflight(api, {
      repository: env.GITHUB_REPOSITORY,
      sha: env.GITHUB_SHA,
      ref: env.GITHUB_REF,
      releaseVersion: args["release-version"],
      notarize: args.notarize,
    });
    process.stderr.write(`publication preflight passed${result.tagExists ? " (tag already exists at this commit)" : ""}\n`);
    process.stdout.write("publish-preflight-ok\n");
    return 0;
  }

  throw new Refused("usage: macos-evidence.mjs select|readback|frozen-candidate|gate-run|publish-preflight --flag value …");
}

// Compared through realpath. A plain `resolve()` comparison is false whenever
// the script is invoked through a symlinked path (macOS's /var -> /private/var,
// a symlinked checkout), and a judge that silently never runs exits 0 — which
// every caller below would read as a pass. The callers ALSO require the
// verdict line each command prints, so a no-op is caught twice.
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
      process.stderr.write(`::error::${error instanceof Refused || error instanceof Unavailable ? "" : "unexpected: "}${error.message}\n`);
      process.exitCode = 1;
    },
  );
}
