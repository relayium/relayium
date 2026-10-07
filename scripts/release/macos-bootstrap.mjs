// scripts/release/macos-bootstrap.mjs — the SECOND signed-build producer the
// macOS release may reuse: the `macos / ` call of a `merge-gate.yml`
// full-bootstrap dispatch of protected `main`.
//
// ## Why it exists
//
// A change whose `push: main` triggers do not select `macos.yml` (a release
// script, the merge gate itself) leaves no push run of `macos.yml` at its
// commit, so `macos-evidence.mjs` falls back to a cold rebuild — even when the
// operator already ran a full bootstrap of that exact commit, which called
// `macos.yml` with its CI defaults, executed both UI shards and uploaded the
// same signed artifact a push run would have. This file lets `select` reuse
// THAT build, and lets the handoff verifier re-prove it later, without
// widening the push path at all.
//
// ## What it may never do
//
//   * be consulted while ANY push run of `macos.yml` exists at the commit —
//     failed, pending, foreign or ambiguous (`NoPushRun` is raised only for a
//     push listing that is empty), so a red push is never hidden;
//   * accept a dispatch whose mode it cannot prove. GitHub's API does not
//     report dispatch inputs, and a `pull-request` dispatch on `main` can run
//     the same lanes, so the run must carry the aggregate's receipt — written
//     by the two pinned steps at the end of `merge-gate.yml`, after the
//     judgement passed, uploaded inside the aggregate's original execution —
//     whose every field equals what the API proves;
//   * read the caller or callee from anywhere but the commit itself, or judge
//     the run's lanes with anything but that commit's own roster
//     (`loadBaseJudges` + `judgeGateLanes`, every lane required);
//   * accept partial native coverage: the `macos / ` roster must be exactly the
//     five gate jobs, each EXECUTED (`judgeProducerRoster`, called), plus the
//     adoption auxiliaries as a `workflow_call` leaves them;
//   * mint, forward or stand in for an F proof. The receipt is E evidence only;
//     `scripts/ci/ci-evidence.mjs` never reads it and the producer conditions
//     that mint proofs do not include this mode;
//   * make an earlier full bootstrap eligible: a commit whose `merge-gate.yml`
//     lacks the pinned receipt steps is `Unavailable`, whatever artifacts its
//     run carries.
//
// Imported dynamically by `macos-evidence.mjs` (only after the push listing
// came back empty) and by `macos-handoff.mjs` (only for a
// `main-full-bootstrap` record); it imports both statically, so neither ever
// loads it during its own initialization. Node standard library only.

import { createHash } from "node:crypto";

import {
  BOOTSTRAP_KIND,
  COVERAGE_EXECUTED,
  EVIDENCE_SCHEMA_V3,
  EXPECTED_JOBS,
  GATE_WORKFLOW,
  MAX_RUN_AGE_HOURS,
  MIN_ARTIFACT_REMAINING_HOURS,
  RECEIPT_ARTIFACT,
  Refused,
  Unavailable,
  coverageOf,
  downloadSignedPayload,
  judgeExecutionOrigin,
  judgeGateRun,
  judgeProducerRoster,
  judgeProvenance,
  paginate,
  readProducerShape,
  sameRepository,
  selectArtifact,
  workflowPathOf,
} from "./macos-evidence.mjs";
import { judgeGateLanes, loadBaseJudges, sourceGitAt, stepWindow } from "./macos-handoff.mjs";
import { artifactIdentityOf, readSingleEntryZip } from "../ci/ci-evidence.mjs";

export const BOOTSTRAP_MODE = "full-bootstrap";
/** The merge-gate caller job and the prefix GitHub gives every job it calls. */
export const CALLER_JOB = "macos";
export const CALLER_PREFIX = "macos / ";
export const AGGREGATE_JOB = "merge-gate";
export const RECEIPT_SCHEMA = "relayium-macos-full-bootstrap-receipt/v1";
export const RECEIPT_ENTRY = "full-bootstrap-receipt.json";
const RECEIPT_BYTES = 16 * 1024;
export const RECEIPT_KEYS = Object.freeze(["base", "head", "mode", "ref", "repositoryId", "runAttempt", "runId", "schema",
  "sha", "signedArtifact", "workflowRef", "workflowSha"]);
export const JUDGE_STEP = "Judge every lane";
export const RECORD_STEP = "Record the full-bootstrap signed-build receipt";
export const KEEP_STEP = "Keep the full-bootstrap signed-build receipt";

/**
 * The merge-gate `macos:` caller, structurally (comments and blank lines are
 * ignored): the callee at its fixed path, the selector predicate, the
 * read-only grants, the four named secrets — and NO `with:`, so the callee's
 * three inputs take their CI defaults (empty release version, both false).
 */
export const CANONICAL_MACOS_CALLER = Object.freeze([
  "  macos:",
  "    needs: select",
  "    if: needs.select.outputs['macos'] == 'true'",
  "    uses: ./.github/workflows/macos.yml",
  "    permissions:",
  "      contents: read",
  "      actions: read",
  "      pull-requests: read",
  "    secrets:",
  "      MACOS_SIGNING_CERT_P12_BASE64: ${{ secrets.MACOS_SIGNING_CERT_P12_BASE64 }}",
  "      MACOS_SIGNING_CERT_PASSWORD: ${{ secrets.MACOS_SIGNING_CERT_PASSWORD }}",
  "      MACOS_PROVISIONING_PROFILE_BASE64: ${{ secrets.MACOS_PROVISIONING_PROFILE_BASE64 }}",
  "      MACOS_SHARE_PROVISIONING_PROFILE_BASE64: ${{ secrets.MACOS_SHARE_PROVISIONING_PROFILE_BASE64 }}",
]);

/** The aggregate's two receipt steps, byte for byte, as the LAST steps of the last job. */
export const CANONICAL_RECEIPT_STEPS = Object.freeze([
  `      - name: ${RECORD_STEP}`,
  "        if: github.event_name == 'workflow_dispatch' && inputs.mode == 'full-bootstrap'",
  "        env:",
  "          RECEIPT_MODE: ${{ inputs.mode }}",
  "          RECEIPT_BASE: ${{ inputs.base_sha }}",
  "          RECEIPT_HEAD: ${{ inputs.head_sha }}",
  "          RECEIPT_SIGNED_ARTIFACT: ${{ needs.macos.outputs.signed_artifact }}",
  "        run: |",
  "          set -euo pipefail",
  "          mkdir -p \"$RUNNER_TEMP/full-bootstrap\"",
  "          jq -n --arg mode \"$RECEIPT_MODE\" --arg base \"$RECEIPT_BASE\" --arg head \"$RECEIPT_HEAD\" \\",
  "            --arg sha \"$GITHUB_SHA\" --arg ref \"$GITHUB_REF\" --arg repositoryId \"$GITHUB_REPOSITORY_ID\" \\",
  "            --arg runId \"$GITHUB_RUN_ID\" --arg runAttempt \"$GITHUB_RUN_ATTEMPT\" \\",
  "            --arg workflowRef \"$GITHUB_WORKFLOW_REF\" --arg workflowSha \"$GITHUB_WORKFLOW_SHA\" \\",
  "            --arg signedArtifact \"$RECEIPT_SIGNED_ARTIFACT\" \\",
  "            '{schema:\"relayium-macos-full-bootstrap-receipt/v1\",mode:$mode,base:$base,head:$head,sha:$sha,ref:$ref,",
  "              repositoryId:$repositoryId,runId:$runId,runAttempt:$runAttempt,workflowRef:$workflowRef,",
  "              workflowSha:$workflowSha,signedArtifact:$signedArtifact}' \\",
  "            > \"$RUNNER_TEMP/full-bootstrap/full-bootstrap-receipt.json\"",
  `      - name: ${KEEP_STEP}`,
  "        if: github.event_name == 'workflow_dispatch' && inputs.mode == 'full-bootstrap'",
  "        uses: actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a # v7.0.1",
  "        with:",
  "          name: relayium-macos-full-bootstrap-receipt-attempt-${{ github.run_attempt }}",
  "          path: ${{ runner.temp }}/full-bootstrap/full-bootstrap-receipt.json",
  "          if-no-files-found: error",
  "          retention-days: 14",
]);

/**
 * The callee's `workflow_call` inputs, structurally and without their prose
 * descriptions: exactly three, each optional with the CI default. The caller
 * passes none, so these defaults ARE what the bootstrap's build ran with.
 */
export const CANONICAL_CALLEE_INPUTS = Object.freeze([
  "  workflow_call:",
  "    inputs:",
  "      release_version:",
  "        required: false",
  "        default: ''",
  "        type: string",
  "      notarize:",
  "        required: false",
  "        default: false",
  "        type: boolean",
  "      publish_release:",
  "        required: false",
  "        default: false",
  "        type: boolean",
]);

const SHA40 = /^[0-9a-f]{40}$/;
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const hours = (ms) => ms / 3_600_000;
function refuse(condition, message) {
  if (!condition) throw new Refused(message);
}
function unavailable(condition, message) {
  if (!condition) throw new Unavailable(message);
}
const structural = (lines) => lines.filter((l) => l.trim() !== "" && !l.trim().startsWith("#"));

/** Two-space job blocks under `jobs:`, in order, as [id, structural lines]. */
function jobBlocks(text) {
  const lines = text.split("\n");
  const at = lines.indexOf("jobs:");
  if (at < 0) return null;
  const blocks = [];
  for (let i = at + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.trim() !== "" && !line.startsWith(" ") && !line.startsWith("#")) break;
    const id = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(line);
    if (id) blocks.push({ id: id[1], start: i });
  }
  blocks.forEach((b, k) => { b.lines = structural(lines.slice(b.start, k + 1 < blocks.length ? blocks[k + 1].start : lines.length)); });
  return blocks;
}

/**
 * Why `merge-gate.yml` at a commit is NOT the canonical full-bootstrap caller,
 * or `null` when it is: one `macos:` caller exactly `CANONICAL_MACOS_CALLER`;
 * the aggregate is the LAST job, judges every lane, and ends with exactly
 * `CANONICAL_RECEIPT_STEPS`, which appear nowhere else in the file.
 */
export function callerProblem(text) {
  const blocks = jobBlocks(text);
  if (blocks === null || blocks.length === 0) return "it has no jobs: block";
  const macos = blocks.filter((b) => b.id === CALLER_JOB);
  if (macos.length !== 1 || JSON.stringify(macos[0].lines) !== JSON.stringify(CANONICAL_MACOS_CALLER)) {
    return "its macos caller is not exactly the canonical call (callee, predicate, grants, four secrets, no with:)";
  }
  const last = blocks[blocks.length - 1];
  if (last.id !== AGGREGATE_JOB) return `its last job is ${last.id}, not the ${AGGREGATE_JOB} aggregate`;
  const tail = last.lines.slice(-CANONICAL_RECEIPT_STEPS.length);
  if (JSON.stringify(tail) !== JSON.stringify(CANONICAL_RECEIPT_STEPS)) {
    return "its aggregate does not end with the canonical full-bootstrap receipt steps";
  }
  const body = last.lines.slice(0, -CANONICAL_RECEIPT_STEPS.length);
  if (body.filter((l) => l === `      - name: ${JUDGE_STEP}`).length !== 1) {
    return `its aggregate does not judge every lane exactly once before the receipt`;
  }
  for (const name of [RECORD_STEP, KEEP_STEP, RECEIPT_SCHEMA, "relayium-macos-full-bootstrap-receipt-attempt-"]) {
    if (text.split(name).length !== 2) return `it names ${JSON.stringify(name)} outside the canonical receipt steps`;
  }
  return null;
}

/** Why the callee's `workflow_call` inputs are not the CI-default three, or `null`. */
export function calleeInputsProblem(text) {
  const lines = text.split("\n");
  const from = lines.indexOf("  workflow_call:");
  if (from < 0) return "it has no workflow_call trigger";
  const to = lines.findIndex((l, i) => i > from && (l === "    secrets:" || l === "    outputs:" || /^\S/.test(l) || /^ {2}\S/.test(l)));
  const inputs = structural(lines.slice(from, to < 0 ? lines.length : to)).filter((l) => !/^ {8}description:/.test(l));
  return JSON.stringify(inputs) === JSON.stringify(CANONICAL_CALLEE_INPUTS)
    ? null : "its workflow_call inputs are not exactly release_version='' and notarize/publish_release=false";
}

/** `merge-gate.yml` at the immutable commit, through the contents API, and its blob. */
async function readCaller(api, { repository, sha }) {
  const file = await api.get(`/repos/${repository}/contents/${GATE_WORKFLOW}?ref=${sha}`);
  refuse(file?.path === GATE_WORKFLOW && file?.encoding === "base64" && typeof file?.content === "string"
    && SHA40.test(file?.sha ?? ""), `the contents API did not return ${GATE_WORKFLOW} at ${sha}`);
  const text = Buffer.from(file.content, "base64").toString("utf8");
  const problem = callerProblem(text);
  unavailable(problem === null, `${GATE_WORKFLOW} at ${sha} is not a full-bootstrap caller this file can prove: ${problem}`);
  return { blob: file.sha, text };
}

/**
 * The receipt, authenticated: the ONE artifact of the run named for an
 * attempt, that attempt the run's latest, its record by id equal to the
 * listing (all ten identity fields), unexpired — with the selection margin
 * (`freshAt`) or strictly at the machine clock (`clock`, a historical verify)
 * — its bytes the API digest, one strict entry, exactly the twelve keys, and
 * every value what the API proved. Returns the identity and the fields.
 */
async function authenticateReceipt(api, { repository, repositoryId, sha, run, artifacts, freshAt, clock }) {
  const receipts = artifacts.filter((a) => RECEIPT_ARTIFACT.test(String(a?.name ?? "")));
  unavailable(receipts.length > 0, `merge-gate run ${run.id} carries no full-bootstrap receipt; `
    + "its dispatch mode is unproven, so it is not a full bootstrap");
  unavailable(receipts.length === 1, `merge-gate run ${run.id} carries ${receipts.length} full-bootstrap receipts; reuse needs exactly one`);
  const attempt = Number(RECEIPT_ARTIFACT.exec(receipts[0].name)[1]);
  refuse(attempt === run.run_attempt,
    `merge-gate run ${run.id}'s receipt is of attempt ${attempt}, but its latest attempt is ${run.run_attempt}`);
  const identity = artifactIdentityOf(receipts[0]);
  refuse(identity !== null && identity.run_id === run.id && identity.head_sha === sha
    && identity.repository_id === repositoryId && identity.head_repository_id === repositoryId,
  `receipt ${receipts[0]?.id} is not an artifact of merge-gate run ${run.id} at ${sha} in this repository`);
  const record = await api.get(`/repos/${repository}/actions/artifacts/${identity.id}`);
  refuse(JSON.stringify(artifactIdentityOf(record)) === JSON.stringify(identity),
    `receipt ${identity.id} changed between the listing and its record`);
  unavailable(receipts[0].expired === false && record.expired === false, `receipt ${identity.id} has expired`);
  const expires = Date.parse(identity.expires_at);
  if (freshAt !== null) {
    unavailable(Number.isFinite(expires) && hours(expires - freshAt) >= MIN_ARTIFACT_REMAINING_HOURS,
      `receipt ${identity.id} expires in under ${MIN_ARTIFACT_REMAINING_HOURS} hours`);
  } else {
    const at = clock();
    refuse(Number.isFinite(expires) && expires > at, `receipt ${identity.id} expired at ${identity.expires_at}`);
  }
  let zip;
  try {
    zip = await api.download(`/repos/${repository}/actions/artifacts/${identity.id}/zip`);
  } catch (error) {
    if (error?.status === 404 || error?.status === 410) {
      throw new Unavailable(`receipt ${identity.id} could not be downloaded (HTTP ${error.status})`);
    }
    throw error;
  }
  refuse(Buffer.isBuffer(zip) && `sha256:${sha256(zip)}` === identity.digest,
    `receipt ${identity.id} downloaded as sha256:${sha256(Buffer.from(zip ?? []))}, but the API digest is ${identity.digest}`);
  let fields;
  try {
    fields = JSON.parse(readSingleEntryZip(zip, RECEIPT_ENTRY, RECEIPT_BYTES).toString("utf8"));
  } catch (error) {
    throw new Refused(`receipt ${identity.id} is not one strict ${RECEIPT_ENTRY}: ${error.message}`);
  }
  refuse(fields !== null && typeof fields === "object" && !Array.isArray(fields)
    && JSON.stringify(Object.keys(fields).sort()) === JSON.stringify(RECEIPT_KEYS),
  `receipt ${identity.id} has keys ${JSON.stringify(Object.keys(fields ?? {}).sort())}; want exactly ${JSON.stringify(RECEIPT_KEYS)}`);
  const want = {
    schema: RECEIPT_SCHEMA,
    mode: BOOTSTRAP_MODE,
    base: sha,
    head: sha,
    sha,
    ref: "refs/heads/main",
    repositoryId: String(repositoryId),
    runId: String(run.id),
    runAttempt: String(attempt),
    workflowRef: `${repository}/${GATE_WORKFLOW}@refs/heads/main`,
    workflowSha: sha,
    signedArtifact: `relayium-macos-signed-${sha}-ci`,
  };
  for (const key of RECEIPT_KEYS) {
    refuse(fields[key] === want[key], `receipt.${key} is ${JSON.stringify(fields[key])}, want ${JSON.stringify(want[key])}`);
  }
  return { identity, attempt, fields };
}

/** Steps of one job by name, exactly once, as their step numbers. */
function stepNumber(job, name) {
  const hits = (job.steps ?? []).filter((s) => s?.name === name);
  return hits.length === 1 ? hits[0].number : NaN;
}

/**
 * Everything a full-bootstrap run must be, at its LATEST attempt, from
 * authoritative reads only — shared by a new selection (`freshAt`: the
 * selection instant; margins apply) and a historical handoff verify
 * (`freshAt === null`, `clock`: no freshness rule, only the strict expiry of
 * what must be re-read). `run` is the run record the caller already re-read
 * and bound to this repository, commit, workflow and event.
 *
 * Order matters for the verdict a wrong world gets: a run that is not yet, or
 * no longer, a candidate (latest attempt not a success, a caller or callee
 * that is not the canonical one, no receipt) is `Unavailable`; once a run
 * carries the receipt it CLAIMS to be a full bootstrap, and every
 * disagreement with that claim is `Refused`. A native roster gap stays
 * `Unavailable`, exactly as on the push path.
 */
export async function judgeBootstrapRun(api, { repository, repositoryId, sha, run, cwd, freshAt, clock }) {
  const latest = run.run_attempt;
  refuse(Number.isSafeInteger(latest) && latest >= 1, `merge-gate run ${run.id} has no attempt number`);
  const attempt = await api.get(`/repos/${repository}/actions/runs/${run.id}/attempts/${latest}`);
  refuse(attempt?.id === run.id && attempt?.run_attempt === latest && attempt?.head_sha === sha,
    `attempt ${latest} of merge-gate run ${run.id} does not describe the same run`);
  unavailable(attempt.status === "completed" && attempt.conclusion === "success",
    `attempt ${latest} of merge-gate run ${run.id} is ${attempt.status}/${attempt.conclusion}`);

  // The definitions that run executed: caller and callee AT THE COMMIT.
  const caller = await readCaller(api, { repository, sha });
  const { shape, blob: calleeBlob, text: calleeText } = await readProducerShape(api, { repository, sha });
  const inputs = calleeInputsProblem(calleeText);
  unavailable(inputs === null, `.github/workflows/macos.yml at ${sha} is not the callee a full bootstrap runs: ${inputs}`);

  // The mode, from the only place it is recorded.
  const artifacts = await paginate(api, `/repos/${repository}/actions/runs/${run.id}/artifacts`, "artifacts");
  const receipt = await authenticateReceipt(api, { repository, repositoryId, sha, run, artifacts, freshAt, clock });

  const jobs = await paginate(api, `/repos/${repository}/actions/runs/${run.id}/attempts/${latest}/jobs`, "jobs");
  for (const job of jobs) {
    refuse(job?.run_id === run.id && job?.head_sha === sha,
      `job ${job?.id} listed under merge-gate run ${run.id} belongs to run ${job?.run_id} / ${job?.head_sha}`);
  }
  // The native lane: exactly the five gate jobs, each EXECUTED, and the
  // adoption auxiliaries as a workflow_call leaves them. Its coverage is read
  // from the UNPREFIXED names (the reader matches bare job names), and only
  // executed coverage exists for a called run.
  const called = jobs.filter((job) => String(job?.name ?? "").startsWith(CALLER_PREFIX));
  const bare = called.map((job) => ({ ...job, name: String(job.name).slice(CALLER_PREFIX.length) }));
  refuse(coverageOf(bare, shape) === COVERAGE_EXECUTED,
    `merge-gate run ${run.id}'s macos lane reads as witnessed coverage; a full bootstrap executes every job`);
  const roster = judgeProducerRoster(called, { runId: run.id, sha, latestAttempt: latest, shape, prefix: CALLER_PREFIX, called: true });

  // The receipt's writer: the aggregate's ORIGINAL execution in that attempt,
  // which judged every lane, recorded the receipt and uploaded it — the
  // artifact created inside the upload step, never by a lane job.
  const aggregates = jobs.filter((job) => job?.name === AGGREGATE_JOB);
  refuse(aggregates.length === 1, `merge-gate run ${run.id} lists ${aggregates.length} ${AGGREGATE_JOB} job(s); want exactly one`);
  const aggregate = await judgeExecutionOrigin(api, {
    repository, runId: run.id, sha, workflowPath: GATE_WORKFLOW, jobName: AGGREGATE_JOB,
    originalAttempt: receipt.attempt, latestAttempt: latest, latestJob: aggregates[0],
  });
  const where = `merge-gate run ${run.id}'s ${AGGREGATE_JOB} job`;
  stepWindow(aggregate.job, JUDGE_STEP, where);
  stepWindow(aggregate.job, RECORD_STEP, where);
  const [keepFrom, keepTo] = stepWindow(aggregate.job, KEEP_STEP, where);
  refuse(stepNumber(aggregate.job, JUDGE_STEP) < stepNumber(aggregate.job, RECORD_STEP)
    && stepNumber(aggregate.job, RECORD_STEP) < stepNumber(aggregate.job, KEEP_STEP),
  `${where} did not judge, record and keep the receipt in that order`);
  const created = Date.parse(receipt.identity.created_at);
  refuse(Number.isFinite(created) && created >= keepFrom && created <= keepTo,
    `receipt ${receipt.identity.id} was created at ${receipt.identity.created_at}, outside ${where}'s "${KEEP_STEP}" step`);

  // The whole caller, against the commit's OWN roster: the latest attempt
  // green with no red job anywhere, and every lane's every job — the selector,
  // the aggregate, the planned main-only skips — exactly as that commit's
  // merge-gate.yml, lane workflows and evidence registry say, every lane
  // required. The judges come from the commit's Git objects in `cwd` (whose
  // merge-gate.yml must be the blob the contents API returned), never from the
  // invoking checkout's working tree.
  await judgeGateRun(api, { repository, repositoryId, branch: "main", head: sha, runId: run.id, attempt: latest });
  const git = sourceGitAt(cwd);
  const localBlob = git(["rev-parse", `${sha}:${GATE_WORKFLOW}`]).toString().trim();
  refuse(localBlob === caller.blob, `the checkout's ${GATE_WORKFLOW} at ${sha} is ${localBlob}, not the API's ${caller.blob}`);
  const judges = await loadBaseJudges(sha, cwd);
  try {
    await judgeGateLanes(api, { repository, runId: run.id, attempt: latest, head: sha, expected: judges.allLanes(), judges });
  } finally {
    judges.cleanup();
  }

  const byId = [...jobs].sort((a, b) => a.id - b.id);
  const inventory = byId.map((job) => [job.id, job.name, job.status, job.conclusion, job.run_attempt]);
  return {
    latest,
    shape,
    calleeBlob,
    callerBlob: caller.blob,
    roster,
    signedBuild: roster.jobs[EXPECTED_JOBS.findIndex((e) => e.id === "signed-build")],
    receipt: { attempt: receipt.attempt, identity: receipt.identity },
    aggregate: sha256(Buffer.from(aggregate.identity)),
    inventory: sha256(Buffer.from(JSON.stringify(inventory))),
    // Not frozen into evidence: every job's whole execution (times, runner,
    // labels, steps), so the end of a selection sees any job re-written.
    executions: sha256(Buffer.from(JSON.stringify(byId.map((job) => [job.id, job.name, job.status, job.conclusion,
      job.run_attempt, job.started_at ?? null, job.completed_at ?? null, job.runner_name ?? null, job.labels ?? null,
      (job.steps ?? []).map((st) => [st?.number, st?.name, st?.status, st?.conclusion, st?.started_at ?? null,
        st?.completed_at ?? null])])))),
  };
}

/** The run record, bound to this repository, commit, `main`, dispatch and merge-gate. */
function isBootstrapRun(run, { repositoryId, sha, workflowId }) {
  return run?.head_sha === sha && run?.event === "workflow_dispatch" && run?.head_branch === "main"
    && workflowPathOf(run) === GATE_WORKFLOW && run?.workflow_id === workflowId && sameRepository(run, repositoryId);
}

/**
 * The one dispatched merge-gate run at `sha` on main: exactly one listed, in
 * any mode or state (two are ambiguous, whatever each proves), re-read as a
 * record, its latest attempt a completed success within MAX_RUN_AGE_HOURS.
 */
export async function selectBootstrapRun(api, { repository, repositoryId, sha, now }) {
  let workflow;
  try {
    workflow = await api.get(`/repos/${repository}/actions/workflows/merge-gate.yml`);
  } catch (error) {
    // No such workflow at all is "no bootstrap", not a contradiction.
    if (error?.status === 404) throw new Unavailable(`${GATE_WORKFLOW} is not a workflow of this repository (HTTP 404)`);
    throw error;
  }
  refuse(workflow?.path === GATE_WORKFLOW, `the merge-gate workflow resolves to ${JSON.stringify(workflow?.path)}`);
  refuse(Number.isInteger(workflow?.id), "the merge-gate workflow has no numeric id");
  unavailable(workflow.state === "active", `the merge-gate workflow is ${workflow.state}, not active`);
  const listed = await paginate(api,
    `/repos/${repository}/actions/workflows/${workflow.id}/runs?event=workflow_dispatch&branch=main&head_sha=${sha}`,
    "workflow_runs");
  unavailable(listed.length > 0, `no merge-gate run was dispatched on main for ${sha}`);
  unavailable(listed.length === 1,
    `${listed.length} merge-gate runs were dispatched on main for ${sha}; reuse needs exactly one`);
  unavailable(isBootstrapRun(listed[0], { repositoryId, sha, workflowId: workflow.id }),
    `the merge-gate run dispatched for ${sha} is not a same-repository main dispatch of ${GATE_WORKFLOW}`);
  const run = await api.get(`/repos/${repository}/actions/runs/${listed[0].id}`);
  refuse(run?.id === listed[0].id && isBootstrapRun(run, { repositoryId, sha, workflowId: workflow.id }),
    `merge-gate run ${listed[0].id} changed identity between the list and the record`);
  unavailable(run.status === "completed",
    `merge-gate run ${run.id} is ${run.status} (attempt ${run.run_attempt}); a pending attempt is not evidence`);
  unavailable(run.conclusion === "success", `merge-gate run ${run.id}'s latest attempt ${run.run_attempt} concluded ${run.conclusion}`);
  const created = Date.parse(run.created_at);
  const started = Date.parse(run.run_started_at ?? run.created_at);
  refuse(Number.isFinite(created) && Number.isFinite(started), `merge-gate run ${run.id} has unreadable timestamps`);
  unavailable(hours(now - created) <= MAX_RUN_AGE_HOURS && hours(now - started) <= MAX_RUN_AGE_HOURS
    && created <= now && started <= now, `merge-gate run ${run.id} is older than ${MAX_RUN_AGE_HOURS} hours or not yet started`);
  return { workflow, run };
}

/**
 * The run record and its WHOLE artifact list (every artifact's complete
 * identity), as one comparable value: what must not move between the start
 * and the end of one selection.
 */
async function anchorOf(api, { repository, run }) {
  const now = await api.get(`/repos/${repository}/actions/runs/${run.id}`);
  const artifacts = await paginate(api, `/repos/${repository}/actions/runs/${run.id}/artifacts`, "artifacts");
  return JSON.stringify([[now?.id, now?.run_attempt, now?.status, now?.conclusion, now?.head_sha, now?.head_branch, now?.event,
    now?.workflow_id, now?.created_at, now?.run_started_at ?? null, now?.repository?.id, now?.head_repository?.id],
  artifacts.map(artifactIdentityOf).sort((a, b) => (a?.id ?? 0) - (b?.id ?? 0))]);
}

/**
 * Everything one selection froze, part by part: the caller and callee at the
 * commit, the authenticated receipt, the aggregate's original execution, the
 * job inventory and every job's whole execution, the signed-build's original
 * execution, the run record and its whole artifact list.
 */
function wholeOf(judged, origin, anchor) {
  return {
    "caller": judged.callerBlob,
    "callee": JSON.stringify([judged.calleeBlob, judged.shape]),
    "receipt": JSON.stringify(judged.receipt),
    "aggregate execution": judged.aggregate,
    "job inventory": judged.inventory,
    "job executions": judged.executions,
    "latest attempt": String(judged.latest),
    "signed-build original execution": JSON.stringify([origin.attempt, origin.job.id, origin.identity]),
    "run record or artifact list": anchor,
  };
}

/**
 * The end of a selection, after the slow download: the WHOLE judge again —
 * caller and callee re-read at the commit, the receipt re-authenticated
 * (record, digest, bytes, keep window), every lane and the aggregate re-judged
 * at the latest attempt, the signed-build's original execution re-proved —
 * and every part equal to what the start froze. Any refusal or unavailability
 * now is a world that moved under the selection: refused, never a rebuild.
 */
async function reauthenticate(api, { repository, repositoryId, sha, run, cwd, now, claimed, start }) {
  const where = `merge-gate run ${run.id}`;
  let end;
  try {
    const record = await api.get(`/repos/${repository}/actions/runs/${run.id}`);
    refuse(record?.id === run.id && isBootstrapRun(record, { repositoryId, sha, workflowId: run.workflow_id })
      && record?.status === "completed" && record?.conclusion === "success", `${where} is no longer a successful dispatch on main`);
    const judged = await judgeBootstrapRun(api, { repository, repositoryId, sha, run: record, cwd, freshAt: now, clock: null });
    const origin = await judgeExecutionOrigin(api, {
      repository, runId: run.id, sha, workflowPath: GATE_WORKFLOW, jobName: `${CALLER_PREFIX}signed-build`,
      originalAttempt: claimed, latestAttempt: judged.latest, latestJob: judged.signedBuild,
    });
    end = wholeOf(judged, origin, await anchorOf(api, { repository, run }));
  } catch (error) {
    if (error instanceof Refused || error instanceof Unavailable) {
      throw new Refused(`${where} changed while the evidence was being collected: ${error.message}`);
    }
    throw error;
  }
  for (const part of Object.keys(start)) {
    refuse(end[part] === start[part], `${where} changed while the evidence was being collected: its ${part} is not the one judged`);
  }
}

/**
 * `collectEvidence` for a commit with NO push run: the v3 evidence document of
 * a full-bootstrap producer, or `Unavailable` (naming the empty push listing
 * first) when there is none, or `Refused` when one exists and disagrees.
 */
export async function collectBootstrapEvidence(api, { repository, repositoryId, sha, releaseVersion, now, dir, cwd,
  macosWorkflow, noPush }) {
  try {
    const { workflow, run } = await selectBootstrapRun(api, { repository, repositoryId, sha, now });
    const judged = await judgeBootstrapRun(api, { repository, repositoryId, sha, run, cwd, freshAt: now, clock: null });
    const artifact = await selectArtifact(api, { repository, repositoryId, sha, run, signedBuild: judged.signedBuild, now });
    const before = await anchorOf(api, { repository, run });
    const { files, hashes, provenance, claimed } = await downloadSignedPayload(api, { repository, artifact, dir });
    const origin = await judgeExecutionOrigin(api, {
      repository, runId: run.id, sha, workflowPath: GATE_WORKFLOW, jobName: `${CALLER_PREFIX}signed-build`,
      originalAttempt: claimed, latestAttempt: judged.latest, latestJob: judged.signedBuild,
    });
    const { version, build } = judgeProvenance(provenance, hashes, files.get("Relayium.dmg.sha256").toString("utf8"), {
      kind: BOOTSTRAP_KIND, repository, repositoryId, sha, runId: run.id, signedBuildAttempt: origin.attempt, releaseVersion,
    });
    // The end anchor: after the slow download, the whole producer is judged
    // again and must be, part for part, exactly what was judged before it.
    await reauthenticate(api, { repository, repositoryId, sha, run, cwd, now, claimed,
      start: wholeOf(judged, origin, before) });
    return {
      schema: EVIDENCE_SCHEMA_V3,
      repository,
      repositoryId,
      sha,
      workflow: { id: macosWorkflow?.id, path: macosWorkflow?.path, shape: judged.shape, blob: judged.calleeBlob },
      run: {
        id: run.id,
        attempt: run.run_attempt,
        event: run.event,
        headBranch: run.head_branch,
        conclusion: run.conclusion,
        createdAt: run.created_at,
        runStartedAt: run.run_started_at ?? null,
      },
      jobs: [...judged.roster.jobs, ...judged.roster.auxiliaryJobs].map((job) => ({
        id: job.id,
        name: job.name,
        conclusion: job.conclusion,
        runAttempt: job.run_attempt,
        startedAt: job.started_at,
        completedAt: job.completed_at,
      })),
      signedBuildOrigin: { attempt: origin.attempt, jobId: origin.job.id, execution: sha256(Buffer.from(origin.identity)) },
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
      coverage: { mode: COVERAGE_EXECUTED },
      producer: {
        kind: BOOTSTRAP_KIND,
        caller: { id: workflow.id, path: GATE_WORKFLOW, blob: judged.callerBlob },
        receipt: judged.receipt,
        aggregate: judged.aggregate,
        inventory: judged.inventory,
      },
    };
  } catch (error) {
    if (error instanceof Unavailable) throw new Unavailable(`${noPush}; no full-bootstrap producer either: ${error.message}`);
    throw error;
  }
}

/**
 * The full-bootstrap producer of a handoff's decision, re-proved HISTORICALLY:
 * the run by its id (no listing, no age), its latest attempt green, the same
 * judge as the selection minus every freshness rule, the receipt unexpired at
 * the machine clock, and the signed build's ORIGINAL execution proved from
 * the decision's attempt. Every failure is a refusal: verify has no rebuild.
 */
export async function verifyBootstrapProducer(api, { repository, repositoryId, sha, runId, workflowId, originalAttempt, cwd, clock }) {
  const what = `the full-bootstrap producer run ${runId}`;
  try {
    const run = await api.get(`/repos/${repository}/actions/runs/${runId}`);
    refuse(run?.id === runId && isBootstrapRun(run, { repositoryId, sha, workflowId })
      && run?.status === "completed" && run?.conclusion === "success",
    `${what} is not a successful merge-gate.yml dispatch on main at ${sha}`);
    const judged = await judgeBootstrapRun(api, { repository, repositoryId, sha, run, cwd, freshAt: null, clock });
    const origin = await judgeExecutionOrigin(api, {
      repository, runId, sha, workflowPath: GATE_WORKFLOW, jobName: `${CALLER_PREFIX}signed-build`,
      originalAttempt, latestAttempt: judged.latest, latestJob: judged.signedBuild,
    });
    return { ...judged, origin };
  } catch (error) {
    if (error instanceof Refused) throw new Refused(`${what}: ${error.message}`);
    if (error instanceof Unavailable) throw new Refused(`${what} is not a proved signed build: ${error.message}`);
    throw new Refused(`${what} could not be read (${error?.status ?? error?.message ?? "?"})`);
  }
}
