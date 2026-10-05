#!/usr/bin/env node
// scripts/ci/ci-evidence.mjs — may a `main` push reuse the full proof its
// pull request already produced, instead of running the same tests again?
//
// ## The duplicate this removes
//
// A pull request is gated by `merge-gate.yml`, which calls every selected lane
// on GitHub's synthetic merge commit (`refs/pull/N/merge`). When it merges,
// each lane's own `push: main` trigger runs the whole lane AGAIN on the merge
// result. Measured on #156: the merge ref the gate tested (0c2486e) has tree
// 77a8636, which is exactly the tree of the `main` commit (b51681a) — and main
// spent another 21 minutes of Go, and the iOS lane another 35, re-proving it.
//
// ## What this file is, and what it never is
//
// It is the ONLY place that decides "reuse". Six commands:
//
//   produce        In the merge gate's aggregate job, after every lane has been
//                  judged, on `pull_request` (and the frozen release-metadata
//                  and internal full candidate dispatches, see DISPATCH_KIND
//                  and INTERNAL_KIND) only. Records what the run proved
//                  (exact checkout SHA and tree, PR identity, run/attempt, every
//                  job's final result, per-lane input fingerprints, the tag set,
//                  the verifier/registry hashes, the producer's toolchain) as a
//                  manifest the gate uploads as an artifact. It never decides
//                  anything and always exits 0: no manifest means main runs in
//                  full, it never means the pull request fails.
//
//   witness LANE   In a lane's `evidence` job, on an ORDINARY push to main only.
//                  Independently re-derives every fact from the GitHub API and
//                  git — the merged same-repository pull request, the LATEST
//                  merge-gate run on its final head and that run's latest
//                  attempt, the referenced workflow SHA (the real merge ref,
//                  never `head_sha`), the full paged job inventory, the
//                  immutable artifact by id and API digest — then reads the
//                  manifest without executing anything it downloaded, and
//                  requires the tested tree to equal THIS main commit's whole
//                  tree. Prints `reuse=true` only after re-reading the source
//                  run and the current run. Every doubt, error or mismatch is
//                  `reuse=false` with a bounded reason, and the lane then runs
//                  its original steps. It always exits 0.
//
//   screen LANE    In a lane's `screen` job (lanes with paid macOS/Windows
//                  certify jobs), on an ordinary push to main only. The whole
//                  `witness` check except the current-toolchain comparison:
//                  `eligible=true` only enables the paid probes; it approves
//                  nothing, and anything else means no paid probe and the full
//                  lane. It always exits 0.
//
//   handover       The evidence job's last step, after the witness upload
//                  succeeded: re-reads the retained witness and hands the
//                  decision to the lane's jobs only if it is the decided one.
//
//   confirm LANE   In every witnessed job, first. Binds that job's own check run
//                  to the witness: this lane, this main commit, this run, and a
//                  job id whose every check succeeded in the source run.
//                  Mismatch FAILS the job — a witness path cannot fall back to
//                  platform commands, because it is not on that platform.
//
//   internal-candidate --output FILE
//                  In the merge gate's select job, as BASE's copy of this file
//                  from a BASE worktree, for the `internal-full-candidate`
//                  dispatch only. Judges the checked-out candidate against BASE's
//                  trust closure and writes the verdict the selector turns into
//                  every lane. Unlike the commands above it FAILS on any doubt.
//
// What it never does: let a pull-request event, a dispatch, a release input or
// a called (nested) run reuse anything; accept a PR head SHA as the thing that
// was tested; accept a proof that was itself produced by a witness run (proofs
// come only from `pull_request` runs and the two strict merge-gate dispatches,
// none of which ever witnesses); turn an API error
// into approval; run code from the downloaded artifact.
//
// ## Dependency-free, on purpose
//
// It runs before anything is installed, in jobs whose whole point is to be
// cheap, and it decides whether expensive ones run. Node's standard library
// only, like `select-lanes.mjs`, whose filter reader it reuses for the input
// fingerprints. `scripts/test/ci-evidence-test.mjs` drives every command
// through mocked API, git and archive inputs, including a real local HTTP
// server for the fetch/redirect path.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, posix, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { inflateRawSync } from "node:zlib";

import { CONTROL_FILES, LANES as SELECTOR_LANES, matchesFilter, readPushPaths } from "./select-lanes.mjs";
import {
  TOOLCHAIN_REGISTRY_FILE, ToolchainUnknown, loadToolchainRegistry, toolchainDifferences, validateCertificate,
} from "./ci-evidence-toolchain.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const REGISTRY_FILE = "scripts/ci/ci-evidence-registry.json";
export const VERIFIER_FILE = "scripts/ci/ci-evidence.mjs";
export const SELECTOR_FILE = "scripts/ci/select-lanes.mjs";
export const TOOLCHAIN_FILE = "scripts/ci/ci-evidence-toolchain.mjs";
/** Source certificates: `<prefix><lane>-<jobId>-<strategy.job-index>-attempt-<N>`, one `toolchain.json` each. */
export const TOOLCHAIN_ARTIFACT_PREFIX = "relayium-ci-evidence-toolchain-";
export const TOOLCHAIN_ENTRY = "toolchain.json";
/** How far a current certificate's capture may lie from the decision. */
export const CURRENT_CERT_MAX_AGE_MS = 30 * 60 * 1000;

export const MANIFEST_SCHEMA = "relayium.ci-evidence.proof/v1";
export const MANIFEST_KIND = "merge-gate-pull-request-full-run";
/**
 * The second, separately named proof: the merge gate dispatched by
 * macos-release.yml on a FROZEN release-metadata candidate (mode
 * `frozen-release-metadata`), which checks out the candidate SHA itself — one
 * commit on the current protected main — and which main then fast-forwards to.
 * Only that whitelist mode and only its branch shape; never a development
 * dispatch. The branch pattern is the macOS release lane's own
 * `CANDIDATE_REF` (scripts/release/macos-evidence.mjs), source-for-source
 * (pinned by scripts/test/ci-evidence-test.mjs): group 1 is the version.
 *
 * Neither the mode name nor protected main is trusted. Producer AND consumer
 * each re-derive the candidate's complete change set from the compare API and
 * judge it with BASE's own release-metadata whitelist
 * (`checkCandidateScope` in `SCOPE_FILE`: exactly `CANDIDATE_PATHS`, plus only
 * the optional sitemap), after proving the whitelist module itself is
 * unchanged and byte-identical to BASE's; and each checks the candidate's
 * `web/native-releases.json` macOS version against the branch version.
 */
export const DISPATCH_KIND = "merge-gate-frozen-dispatch-full-run";
export const DISPATCH_MODE = "frozen-release-metadata";
export const FROZEN_REF = /^refs\/heads\/release-candidate\/macos-v([0-9]+(?:\.[0-9]+){1,2})-([1-9][0-9]*)-([1-9][0-9]*)$/;
export const SCOPE_FILE = "web/scripts/macos-release-candidate.mjs";
export const NATIVE_RELEASES_FILE = "web/native-releases.json";
/** Paths a frozen candidate may never touch for its run to be a proof: the gate's own inputs stay BASE's. */
const DISPATCH_FORBIDDEN = (path) => path.startsWith(".github/") || path.startsWith("scripts/");
/** BASE's release-metadata whitelist, imported from the checkout (whose bytes `frozenCandidateScope` proves are BASE's). */
const importScope = () => import(pathToFileURL(resolve(repoRoot, SCOPE_FILE)).href);
/**
 * The third, separately named proof: an INTERNAL FULL CANDIDATE. The root
 * operator pushes one commit on the current protected main to
 * `internal-candidate/<its own SHA>` and dispatches the gate with mode
 * `internal-full-candidate`, which selects EVERY lane; main then fast-forwards
 * to exactly that SHA. It exists so an internal change can be proven green by
 * the full gate BEFORE main moves, without a pull request and without
 * pretending to be release metadata.
 *
 * Unlike the frozen mode it may carry ordinary application, runtime, public
 * copy and owning-test changes — but never a trust input: the gate's own
 * workflows, the selector, the verifier and its registries, the toolchain probe
 * and every module it executes, the release helpers, the workflow guards and
 * the macOS artifact-derived release files (`internalTrustClosure`). The
 * closure is DERIVED from BASE's tree, and every member is byte-compared with
 * BASE's blob. Its proof can therefore never certify a change to the machinery
 * that certifies it; a commit that changes that machinery is bootstrapped by a
 * full run on main.
 *
 * Neither the mode name nor protected main is trusted: the select job (BASE's
 * copy of this file, from a BASE worktree), the producer and the consumer each
 * derive the change set twice — the compare API, and the candidate's own
 * checked-out tree against BASE's tree from the API — and judge it.
 */
export const INTERNAL_KIND = "merge-gate-internal-full-candidate-run";
export const INTERNAL_SCHEMA = "relayium.ci-evidence.internal-proof/v1";
export const INTERNAL_MODE = "internal-full-candidate";
/** The branch names the candidate it carries: `internal-candidate/<head_sha>`. A moved branch no longer matches its name. */
export const INTERNAL_REF = /^refs\/heads\/internal-candidate\/([0-9a-f]{40})$/;
/** Path prefixes whose every file is a trust input. */
export const TRUST_PREFIXES = Object.freeze([".github/", "scripts/ci/", "scripts/release/"]);
/** Where the repository's workflow guards live; a file here that reads `.github/` is one. */
export const GUARD_DIR = "scripts/test/";
const GUARD_MARK = ".github/";
/** Cap on one BASE blob read through the API for the guard judgement. */
const BLOB_MAX = 4 * 1024 * 1024;
export const WITNESS_SCHEMA = "relayium.ci-evidence.witness/v1";
export const REGISTRY_SCHEMA = "relayium.ci-evidence.registry/v1";

/** Lanes the gate calls with no condition; always selected on a pull request. */
export const UNCONDITIONAL_LANES = ["compat", "repo-hygiene"];

/** Hard ceilings. Anything at or past one is not reuse. */
export const LIMITS = Object.freeze({
  zipBytes: 256 * 1024,
  manifestBytes: 256 * 1024,
  pages: 30,
  perPage: 100,
  jobs: 1000,
  runs: 300,
  pulls: 50,
  tags: 3000,
  referencedWorkflows: 64,
  reason: 400,
  clockSkewMs: 5 * 60 * 1000,
});

const HEX40 = /^[0-9a-f]{40}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

/** Every reason not to reuse. Caught at the top and turned into a full run. */
export class NoReuse extends Error {}
/**
 * A `NoReuse` whose cause is ABSENCE — a proof, artifact or run that is missing,
 * expired, still pending or outside its freshness window — rather than a fact
 * that exists and disagrees. Every caller here treats both alike (the lane runs
 * in full); the macOS release reader uses the distinction so an expired proof
 * means "build" while a contradicted one stops the release.
 */
export class ProofUnavailable extends NoReuse {}

const fail = (message) => { throw new NoReuse(message); };
const need = (ok, message) => { if (!ok) fail(message); };
const needAvailable = (ok, message) => { if (!ok) throw new ProofUnavailable(message); };
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const isInt = (v) => Number.isSafeInteger(v) && v > 0;
/** A positive decimal integer as the runner writes it (`"2"`, never `"02"`, `"2.0"` or `"1e3"`), or NaN. */
const envInt = (v) => (typeof v === "string" && /^[1-9][0-9]{0,15}$/.test(v) ? Number(v) : Number.NaN);
const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const oneLine = (text) => String(text).replace(/[\r\n]+/g, " ").slice(0, LIMITS.reason);
const isoSeconds = (date) => date.toISOString().replace(/\.\d{3}Z$/, "Z");

// ── the registry ────────────────────────────────────────────────────────────

/**
 * The registry, read and checked. A registry this file does not understand is
 * not a registry: every lane then runs in full.
 */
export function loadRegistry(text) {
  let doc;
  try { doc = JSON.parse(text); } catch (err) { fail(`the registry is not JSON: ${err.message}`); }
  need(isObject(doc) && doc.schema === REGISTRY_SCHEMA, "the registry schema is not " + REGISTRY_SCHEMA);
  need(Number.isFinite(doc.maxAgeHours) && doc.maxAgeHours > 0 && doc.maxAgeHours <= 168,
    "the registry maxAgeHours is not a finite bound of at most a week");
  const p = doc.producer;
  need(isObject(p) && p.workflow === "merge-gate.yml" && p.aggregateJob === "merge-gate"
    && p.selectJob === "select" && typeof p.artifactPrefix === "string" && p.artifactPrefix.length > 0
    && p.entry === "ci-evidence.json", "the registry producer block is not the merge gate");
  need(isObject(doc.lanes) && Object.keys(doc.lanes).length > 0, "the registry names no lanes");
  const known = new Set([...SELECTOR_LANES.map((l) => l.id), ...UNCONDITIONAL_LANES]);
  for (const [id, lane] of Object.entries(doc.lanes)) {
    need(known.has(id), `the registry lane ${id} is not a lane the merge gate calls`);
    need(isObject(lane) && typeof lane.workflow === "string" && /^[a-z0-9-]+\.yml$/.test(lane.workflow),
      `the registry lane ${id} has no workflow file`);
    const selector = SELECTOR_LANES.find((l) => l.id === id);
    need(!selector || selector.workflow === lane.workflow,
      `the registry lane ${id} names ${lane.workflow}, the selector calls ${selector?.workflow}`);
    need(isObject(lane.jobs) && Object.keys(lane.jobs).length > 0, `the registry lane ${id} has no jobs`);
    const seen = new Set();
    for (const [jobId, job] of Object.entries(lane.jobs)) {
      need(/^[a-z0-9-]+$/.test(jobId) && jobId !== "evidence", `the registry job ${id}/${jobId} has an unusable id`);
      need(Array.isArray(job.checks) && job.checks.length > 0
        && job.checks.every((c) => typeof c === "string" && c.length > 0 && c.length <= 100),
      `the registry job ${id}/${jobId} names no checks`);
      for (const check of job.checks) {
        need(!seen.has(check), `the registry lane ${id} names the check ${JSON.stringify(check)} twice`);
        seen.add(check);
      }
      need(typeof job.runner === "string" && /^[a-z0-9.-]+$/.test(job.runner), `the registry job ${id}/${jobId} has no runner`);
      need(job.mode === undefined || job.mode === "fresh" || job.mode === "reuse", `the registry job ${id}/${jobId} has an unknown mode`);
      need(job.freshSteps === undefined || (Array.isArray(job.freshSteps)
        && job.freshSteps.every((s) => typeof s === "string" && s.length > 0)),
      `the registry job ${id}/${jobId} has malformed freshSteps`);
      need(!job.freshSteps || job.runner === "ubuntu-latest",
        `the registry job ${id}/${jobId} keeps steps fresh on ${job.runner}; a witness runs only on ubuntu-latest`);
      // A second runner, for a dispatched source only, exists solely for a job
      // whose own runs-on reads the event (macOS `contract`). Never on a job a
      // witness may vouch for: a reused job is certified on ONE toolchain family.
      need(job.dispatchRunner === undefined || (job.mode === "fresh" && typeof job.dispatchRunner === "string"
        && /^[a-z0-9.-]+$/.test(job.dispatchRunner) && job.dispatchRunner !== job.runner),
      `the registry job ${id}/${jobId} has a dispatchRunner but is not a fresh job with a second, different runner`);
    }
    if (lane.scope !== undefined) {
      const s = lane.scope;
      need(isObject(s) && typeof s.job === "string" && lane.jobs[s.job]?.mode === "fresh"
        && typeof s.output === "string" && Array.isArray(s.gates) && s.gates.length > 0
        && s.gates.every((g) => lane.jobs[g] !== undefined), `the registry lane ${id} has a malformed scope`);
    }
    need(lane.externalInputs === undefined || (Array.isArray(lane.externalInputs) && lane.externalInputs.length > 0
      && lane.externalInputs.every((x) => isObject(x) && Object.keys(x).sort().join() === "artifactPrefix,entry,job,kind"
        && x.kind === "git-tags" && lane.jobs[x.job] !== undefined && lane.jobs[x.job].mode !== "fresh"
        && /^relayium-ci-evidence-[a-z0-9-]+-attempt-$/.test(x.artifactPrefix) && /^[a-z0-9-]+\.txt$/.test(x.entry))),
    `the registry lane ${id} has an unknown or malformed external input`);
    need(lane.unfiltered === undefined || lane.unfiltered === true, `the registry lane ${id} has a malformed unfiltered flag`);
  }
  return doc;
}

const readRepoFile = (path) => readFileSync(resolve(repoRoot, path));

// ── strict JSON shapes ──────────────────────────────────────────────────────

/** `spec` maps every allowed key to a predicate; extra or missing keys fail. */
function shape(value, spec, where) {
  need(isObject(value), `${where} is not an object`);
  const keys = Object.keys(value).sort();
  const want = Object.keys(spec).sort();
  need(keys.length === want.length && keys.every((k, i) => k === want[i]),
    `${where} has keys [${keys.join(", ")}], want exactly [${want.join(", ")}]`);
  for (const [key, test] of Object.entries(spec)) {
    if (typeof test === "function") need(test(value[key]), `${where}.${key} is malformed`);
    else shape(value[key], test, `${where}.${key}`);
  }
}

const str = (max = 200) => (v) => typeof v === "string" && v.length > 0 && v.length <= max;
const optStr = (max = 200) => (v) => typeof v === "string" && v.length <= max;
const hex40 = (v) => typeof v === "string" && HEX40.test(v);
const hex64 = (v) => typeof v === "string" && HEX64.test(v);
const iso = (v) => typeof v === "string" && ISO.test(v) && !Number.isNaN(Date.parse(v));
const eq = (want) => (v) => v === want;

/** The proof document, structurally. Values are cross-checked separately. */
export function validateManifest(m) {
  const internal = m?.kind === INTERNAL_KIND;
  const dispatched = m?.kind === DISPATCH_KIND || internal;
  const candidateRef = internal ? INTERNAL_REF : FROZEN_REF;
  const sortedPaths = (max) => (v) => Array.isArray(v) && v.length > 0 && v.length < max && v.every(str(400))
    && v.every((p, i) => i === 0 || v[i - 1] < p);
  const holds = (spec) => (v) => { try { shape(v, spec, "x"); return true; } catch { return false; } };
  shape(m, {
    schema: eq(internal ? INTERNAL_SCHEMA : MANIFEST_SCHEMA),
    kind: (v) => v === MANIFEST_KIND || v === DISPATCH_KIND || v === INTERNAL_KIND,
    produced_at: iso,
    repository: { id: isInt, full_name: (v) => typeof v === "string" && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(v) },
    pull_request: dispatched ? (v) => v === null : holds({
      number: isInt, head_sha: hex40, base_sha: hex40, base_ref: str(255),
      head_repository_id: isInt, same_repository: (v) => v === true,
    }),
    dispatch: internal ? holds({
      mode: eq(INTERNAL_MODE), base_sha: hex40, head_sha: hex40, ref: (v) => typeof v === "string" && INTERNAL_REF.test(v),
      // Both sides of up to 299 renames.
      paths: sortedPaths(600),
      closure_sha256: hex64,
    }) : dispatched ? holds({
      mode: eq(DISPATCH_MODE), base_sha: hex40, head_sha: hex40, ref: (v) => typeof v === "string" && FROZEN_REF.test(v),
      version: (v) => typeof v === "string" && /^[0-9]+(\.[0-9]+){1,2}$/.test(v),
      paths: sortedPaths(300),
      scope_sha256: hex64,
    }) : (v) => v === null,
    run: {
      id: isInt, attempt: isInt, event: eq(dispatched ? "workflow_dispatch" : "pull_request"),
      workflow_path: eq(".github/workflows/merge-gate.yml"), workflow_ref: str(400), workflow_sha: hex40,
    },
    checkout: {
      sha: hex40, tree: hex40,
      ref: (v) => typeof v === "string" && (dispatched ? candidateRef.test(v) : /^refs\/pull\/[1-9][0-9]*\/merge$/.test(v)),
      parents: (v) => Array.isArray(v) && v.length === (dispatched ? 1 : 2) && v.every(hex40),
    },
    referenced_workflows: (v) => Array.isArray(v) && v.length > 0 && v.length <= LIMITS.referencedWorkflows
      && v.every((r) => isObject(r) && Object.keys(r).sort().join() === "path,ref,sha"
        && str(400)(r.path) && hex40(r.sha) && str(255)(r.ref)),
    lanes: (v) => isObject(v) && Object.values(v).every((l) => isObject(l)
      && Object.keys(l).sort().join() === "result,selected" && typeof l.selected === "boolean"
      && ["success", "skipped", "failure", "cancelled"].includes(l.result)),
    jobs: (v) => Array.isArray(v) && v.length > 0 && v.length <= LIMITS.jobs && v.every((j) => isObject(j)
      && Object.keys(j).sort().join() === "conclusion,id,labels,name,status"
      && isInt(j.id) && str(200)(j.name) && j.status === "completed" && str(40)(j.conclusion)
      && Array.isArray(j.labels) && j.labels.length <= 10 && j.labels.every(str(100))),
    fingerprints: (v) => isObject(v) && Object.values(v).every(hex64),
    certification: {
      registry_sha256: hex64, verifier_sha256: hex64, selector_sha256: hex64,
      toolchain_sha256: hex64, toolchain_registry_sha256: hex64,
    },
    toolchain: {
      runner_os: optStr(40), runner_arch: optStr(40), image_os: optStr(40), image_version: optStr(80), node: str(40),
    },
  }, "manifest");
  const ids = new Set(m.jobs.map((j) => j.id));
  need(ids.size === m.jobs.length, "manifest.jobs lists a job id twice");
  const names = new Set(m.jobs.map((j) => j.name));
  need(names.size === m.jobs.length, "manifest.jobs lists a job name twice");
  if (internal) {
    // "Full" is the mode's whole claim: every lane the gate calls ran and passed.
    const want = [...SELECTOR_LANES.map((l) => l.id), ...UNCONDITIONAL_LANES].sort();
    need(JSON.stringify(Object.keys(m.lanes).sort()) === JSON.stringify(want)
      && Object.values(m.lanes).every((l) => l.selected === true && l.result === "success"),
    "manifest.lanes of an internal full candidate is not every lane selected and successful");
  }
  return m;
}

/** The witness a lane's evidence job hands to its jobs, structurally. */
export function validateWitness(w) {
  shape(w, {
    schema: eq(WITNESS_SCHEMA),
    lane: str(60),
    verified_at: iso,
    target: { repository_id: isInt, sha: hex40, tree: hex40, run_id: isInt, run_attempt: isInt, workflow_ref: str(400) },
    source: {
      kind: (v) => v === MANIFEST_KIND || v === DISPATCH_KIND || v === INTERNAL_KIND,
      pull_request: (v) => v === null || isInt(v), head_sha: hex40, merge_sha: hex40, run_id: isInt, run_attempt: isInt,
      artifact_id: isInt, artifact_digest: (v) => typeof v === "string" && /^sha256:[0-9a-f]{64}$/.test(v),
      produced_at: iso,
    },
    jobs: (v) => isObject(v) && Object.keys(v).length > 0 && Object.values(v).every((checks) => Array.isArray(checks)
      && checks.length > 0 && checks.every(str(100))),
    certificates: (v) => isObject(v) && Object.values(v).every((c) => isObject(c)
      && Object.keys(c).sort().join() === "current,profile,source" && str(80)(c.profile) && hex64(c.current)
      && Array.isArray(c.source) && c.source.length > 0 && c.source.every(hex64)),
  }, "witness");
  need(Object.keys(w.certificates).sort().join() === Object.keys(w.jobs).sort().join(),
    "the witness does not certify exactly the jobs it vouches for");
  return w;
}

// ── the archive ─────────────────────────────────────────────────────────────

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
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/**
 * The bytes of the one entry an artifact zip may hold, or `NoReuse`.
 *
 * A reader, not an extractor: nothing is written to disk and nothing is run.
 * Exactly one regular-file entry named `expectedName`, stored or deflated, not
 * encrypted, no ZIP64, every offset inside the buffer, sizes under the cap, and
 * the CRC of what inflated equal to what the archive declared.
 */
export function readSingleEntryZip(buffer, expectedName, maxBytes = LIMITS.manifestBytes) {
  const buf = Buffer.from(buffer);
  need(buf.length >= 22 && buf.length <= LIMITS.zipBytes, `the artifact archive is ${buf.length} bytes`);
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i -= 1) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  need(eocd >= 0, "the artifact archive has no end-of-central-directory record");
  need(eocd + 22 + buf.readUInt16LE(eocd + 20) === buf.length, "the artifact archive has trailing bytes");
  need(buf.readUInt16LE(eocd + 4) === 0 && buf.readUInt16LE(eocd + 6) === 0, "the artifact archive spans disks");
  const onDisk = buf.readUInt16LE(eocd + 8);
  const total = buf.readUInt16LE(eocd + 10);
  need(onDisk === 1 && total === 1, `the artifact archive holds ${total} entries, want exactly 1`);
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  need(cdOffset + cdSize === eocd, "the artifact archive's central directory is not where it says");

  const c = cdOffset;
  need(c + 46 <= eocd && buf.readUInt32LE(c) === 0x02014b50, "the artifact archive's directory entry is malformed");
  const flags = buf.readUInt16LE(c + 8);
  const method = buf.readUInt16LE(c + 10);
  const crc = buf.readUInt32LE(c + 16);
  const csize = buf.readUInt32LE(c + 20);
  const usize = buf.readUInt32LE(c + 24);
  const nameLen = buf.readUInt16LE(c + 28);
  const extraLen = buf.readUInt16LE(c + 30);
  const commentLen = buf.readUInt16LE(c + 32);
  const external = buf.readUInt32LE(c + 38);
  const local = buf.readUInt32LE(c + 42);
  need(c + 46 + nameLen + extraLen + commentLen === eocd, "the artifact archive's directory has extra entries or bytes");
  need((flags & ~0x0808) === 0, `the artifact entry sets flags 0x${flags.toString(16)} (encryption or worse)`);
  need(method === 0 || method === 8, `the artifact entry uses compression method ${method}`);
  need(csize !== 0xffffffff && usize !== 0xffffffff && local !== 0xffffffff, "the artifact archive is ZIP64");
  need(usize <= maxBytes, `the artifact entry inflates to ${usize} bytes, above the ${maxBytes}-byte cap`);
  const name = buf.subarray(c + 46, c + 46 + nameLen).toString("utf8");
  need(name === expectedName, `the artifact entry is ${JSON.stringify(name)}, want ${JSON.stringify(expectedName)}`);
  const type = (external >>> 16) & 0o170000;
  need(type === 0 || type === 0o100000, "the artifact entry is not a regular file");

  need(local + 30 <= cdOffset && buf.readUInt32LE(local) === 0x04034b50, "the artifact entry's local header is malformed");
  const lNameLen = buf.readUInt16LE(local + 26);
  const lExtraLen = buf.readUInt16LE(local + 28);
  need(buf.subarray(local + 30, local + 30 + lNameLen).toString("utf8") === expectedName,
    "the artifact entry's local name disagrees with its directory name");
  need(buf.readUInt16LE(local + 8) === method, "the artifact entry's local method disagrees with its directory");
  const start = local + 30 + lNameLen + lExtraLen;
  need(start + csize <= cdOffset, "the artifact entry's data runs past its directory");
  const raw = buf.subarray(start, start + csize);
  let data;
  if (method === 0) {
    need(csize === usize, "a stored artifact entry's sizes disagree");
    data = raw;
  } else {
    try {
      data = inflateRawSync(raw, { maxOutputLength: maxBytes });
    } catch (err) {
      fail(`the artifact entry does not inflate: ${err.message}`);
    }
  }
  need(data.length === usize, `the artifact entry inflated to ${data.length} bytes, its directory says ${usize}`);
  need(crc32(data) === crc, "the artifact entry's CRC does not match its contents");
  return Buffer.from(data);
}

// ── the API ─────────────────────────────────────────────────────────────────

/**
 * A minimal GitHub REST client. Reads only. A transient failure (network, 5xx,
 * 429) is retried at most twice; anything else is a `NoReuse`. Downloads
 * follow the one redirect GitHub issues WITHOUT forwarding the token.
 */
export function gitHubApi({ token, baseUrl = "https://api.github.com", fetchImpl = globalThis.fetch, sleep } = {}) {
  need(typeof token === "string" && token.length > 0, "no API token");
  const base = new URL(baseUrl);
  const local = base.hostname === "127.0.0.1" || base.hostname === "localhost";
  need(base.protocol === "https:" || (base.protocol === "http:" && local), `the API base ${baseUrl} is not https`);
  const wait = sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const url = (path) => new URL(path.replace(/^\//, ""), base.href.endsWith("/") ? base.href : `${base.href}/`);
  const headers = {
    authorization: `Bearer ${token}`,
    accept: "application/vnd.github+json",
    "x-github-api-version": "2022-11-28",
    "user-agent": "relayium-ci-evidence",
  };

  async function request(path, init) {
    let last = "no attempt";
    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (attempt > 0) await wait(1000 * attempt);
      let res;
      try {
        res = await fetchImpl(url(path), { headers, ...init });
      } catch (err) {
        last = `network: ${err.message}`;
        continue;
      }
      if (res.status >= 500 || res.status === 429) { last = `HTTP ${res.status}`; continue; }
      return res;
    }
    fail(`GET ${path} failed after retries (${last})`);
  }

  return {
    async json(path) {
      const res = await request(path);
      need(res.status === 200, `GET ${path} returned HTTP ${res.status}`);
      try { return await res.json(); } catch (err) { fail(`GET ${path} returned non-JSON: ${err.message}`); }
    },
    async download(path, maxBytes) {
      const first = await request(path, { redirect: "manual" });
      let res = first;
      if (first.status === 301 || first.status === 302 || first.status === 307) {
        const location = first.headers.get("location");
        need(typeof location === "string" && location.length > 0, `GET ${path} redirected nowhere`);
        const target = new URL(location, url(path));
        const ok = target.protocol === "https:" || (target.protocol === "http:" && local);
        need(ok, `GET ${path} redirected to a non-https URL`);
        try {
          res = await fetchImpl(target, { headers: { "user-agent": headers["user-agent"] }, redirect: "error" });
        } catch (err) {
          fail(`downloading ${path} failed: ${err.message}`);
        }
      }
      need(res.status === 200, `downloading ${path} returned HTTP ${res.status}`);
      const declared = Number(res.headers.get("content-length"));
      need(!(declared > maxBytes), `downloading ${path}: ${declared} bytes declared, cap ${maxBytes}`);
      const chunks = [];
      let size = 0;
      for await (const chunk of res.body) {
        size += chunk.length;
        need(size <= maxBytes, `downloading ${path}: more than ${maxBytes} bytes`);
        chunks.push(Buffer.from(chunk));
      }
      return Buffer.concat(chunks);
    },
  };
}

/**
 * Every item of a counted list endpoint (`total_count` + `key`), page by page.
 * The pages must agree on `total_count`, the union must reach it exactly, and
 * it must fit the cap — a short, long or shifting list is not a list.
 */
export async function listCounted(api, path, key, cap) {
  const sep = path.includes("?") ? "&" : "?";
  const items = [];
  let total = null;
  for (let page = 1; page <= LIMITS.pages; page += 1) {
    const body = await api.json(`${path}${sep}per_page=${LIMITS.perPage}&page=${page}`);
    need(isObject(body) && Number.isSafeInteger(body.total_count) && body.total_count >= 0
      && Array.isArray(body[key]), `${path} page ${page} is not a {total_count, ${key}} page`);
    if (total === null) total = body.total_count;
    need(body.total_count === total, `${path}: total_count moved from ${total} to ${body.total_count} between pages`);
    need(total <= cap, `${path}: ${total} entries, above the cap of ${cap}`);
    items.push(...body[key]);
    if (items.length >= total || body[key].length === 0) break;
  }
  need(items.length === total, `${path}: read ${items.length} entries, total_count says ${total}`);
  return items;
}

/** Every item of an uncounted array endpoint, until a short page. */
export async function listArray(api, path, cap) {
  const sep = path.includes("?") ? "&" : "?";
  const items = [];
  for (let page = 1; page <= LIMITS.pages; page += 1) {
    const body = await api.json(`${path}${sep}per_page=${LIMITS.perPage}&page=${page}`);
    need(Array.isArray(body), `${path} page ${page} is not an array`);
    items.push(...body);
    need(items.length <= cap, `${path}: more than ${cap} entries`);
    if (body.length < LIMITS.perPage) return items;
  }
  fail(`${path}: more than ${LIMITS.pages} pages`);
}

// ── git and fingerprints ────────────────────────────────────────────────────

export function realGit(args, cwd = process.cwd()) {
  const r = spawnSync("git", args, { cwd, encoding: "buffer", maxBuffer: 256 * 1024 * 1024 });
  need(r.status === 0, `git ${args.join(" ")} failed: ${(r.stderr ?? Buffer.alloc(0)).toString().trim()}`);
  return r.stdout;
}

/**
 * HEAD's commit, tree and parents, read from git. The parents come from the
 * commit object's own header, not `%P`: in actions/checkout's default depth-1
 * clone the parents are shallow boundaries, and `%P` reports none at all —
 * while the raw `parent` lines, which the commit's SHA covers, are intact.
 * Only the header (up to the first blank line) counts, in git's own order:
 * one tree, its parents, then author and committer. A message that mentions a
 * parent is not a parent.
 */
export function headFacts(git) {
  const [sha, tree] = git(["show", "-s", "--format=%H%n%T", "HEAD"]).toString().trim().split("\n");
  need(HEX40.test(sha ?? "") && HEX40.test(tree ?? ""), "git did not report HEAD's commit and tree");
  const raw = git(["cat-file", "commit", sha]).toString("utf8");
  const end = raw.indexOf("\n\n");
  need(end > 0, `commit ${sha} has no header`);
  const lines = raw.slice(0, end).split("\n");
  need(lines[0] === `tree ${tree}`, `commit ${sha}'s header does not open with its tree ${tree}`);
  let i = 1;
  const parents = [];
  for (; lines[i]?.startsWith("parent "); i += 1) {
    const parent = lines[i].slice("parent ".length);
    need(HEX40.test(parent), `commit ${sha} has a malformed parent line ${JSON.stringify(lines[i])}`);
    parents.push(parent);
  }
  need(lines[i]?.startsWith("author ") && lines[i + 1]?.startsWith("committer ")
    && lines.slice(i).every((line) => !/^(tree|parent) /.test(line)), `commit ${sha}'s header is malformed`);
  return { sha, tree, parents };
}

/**
 * sha256 over every tracked blob a lane's `push.paths` selects, as
 * `mode type object\tpath` lines in path order. An unfiltered lane covers the
 * whole tree. Read from git's own tree listing — no file is opened.
 */
export function laneFingerprint(git, laneId, lane, workflowsDir, readWorkflow = (path) => readFileSync(path, "utf8")) {
  const entries = git(["ls-tree", "-r", "-z", "--full-tree", "HEAD"]).toString("utf8").split("\0").filter(Boolean);
  let patterns = null;
  if (!lane.unfiltered) {
    patterns = readPushPaths(readWorkflow(resolve(workflowsDir, lane.workflow)), lane.workflow);
  }
  const chosen = entries.filter((line) => {
    const path = line.slice(line.indexOf("\t") + 1);
    return patterns === null || matchesFilter(patterns, path);
  }).sort((a, b) => {
    const pa = a.slice(a.indexOf("\t") + 1);
    const pb = b.slice(b.indexOf("\t") + 1);
    return pa < pb ? -1 : pa > pb ? 1 : 0;
  });
  need(chosen.length > 0, `lane ${laneId} selects no tracked file`);
  return sha256(chosen.join("\n") + "\n");
}

/** sha256 of the repository's tag set (`refs/tags/x object` lines, sorted). */
export async function tagFingerprint(api, repository) {
  const refs = await listArray(api, `repos/${repository}/git/matching-refs/tags`, LIMITS.tags);
  const lines = refs.map((r) => {
    need(isObject(r) && typeof r.ref === "string" && r.ref.startsWith("refs/tags/")
      && isObject(r.object) && HEX40.test(r.object.sha ?? ""), "a tag ref is malformed");
    return `${r.ref} ${r.object.sha}`;
  }).sort();
  need(new Set(lines).size === lines.length, "the tag listing repeats a ref");
  return sha256(lines.length === 0 ? "" : `${lines.join("\n")}\n`);
}

/**
 * One immutable artifact of `run`, by exact name: unexpired, from that run, head
 * and repository, with an API digest its bytes match. Returns the zip bytes.
 */
async function runArtifact(api, repository, run, prHead, repositoryId, name, now) {
  const artifacts = await listCounted(api, `repos/${repository}/actions/runs/${run.id}/artifacts?name=${encodeURIComponent(name)}`,
    "artifacts", 20);
  const hits = artifacts.filter((a) => isObject(a) && a.name === name);
  needAvailable(hits.length > 0, `the source run carries ${hits.length} artifact(s) named ${name}, want 1`);
  need(hits.length === 1, `the source run carries ${hits.length} artifact(s) named ${name}, want 1`);
  const art = hits[0];
  need(isInt(art.id) && iso(art.expires_at), `artifact ${art.id} has expired`);
  needAvailable(art.expired === false && Date.parse(art.expires_at) > now().getTime(), `artifact ${art.id} has expired`);
  need(art.workflow_run?.id === run.id && art.workflow_run?.head_sha === prHead
    && art.workflow_run?.repository_id === repositoryId && art.workflow_run?.head_repository_id === repositoryId,
  `artifact ${art.id} is not from merge-gate run ${run.id} on ${prHead}`);
  need(typeof art.digest === "string" && /^sha256:[0-9a-f]{64}$/.test(art.digest), `artifact ${art.id} has no sha256 digest`);
  need(Number.isSafeInteger(art.size_in_bytes) && art.size_in_bytes > 0 && art.size_in_bytes <= LIMITS.zipBytes,
    `artifact ${art.id} is ${art.size_in_bytes} bytes`);
  const zip = await api.download(`repos/${repository}/actions/artifacts/${art.id}/zip`, LIMITS.zipBytes);
  need(`sha256:${sha256(zip)}` === art.digest, `artifact ${art.id}'s bytes do not match its API digest`);
  return { art, zip };
}

/** The fingerprint of the tag set a lane job recorded right after its own checkout. */
async function testedTagFingerprint(api, repository, run, prHead, repositoryId, attempt, input, now) {
  const { zip } = await runArtifact(api, repository, run, prHead, repositoryId, `${input.artifactPrefix}${attempt}`, now);
  const text = readSingleEntryZip(zip, input.entry).toString("utf8");
  const lines = text === "" ? [] : text.split("\n");
  need(lines.length === 0 || lines.pop() === "", `the tested tag set does not end with a newline`);
  need(lines.length <= LIMITS.tags, "the tested tag set is above its cap");
  for (const line of lines) {
    need(/^refs\/tags\/[^\s]+ [0-9a-f]{40}$/.test(line), `the tested tag set has a malformed line ${JSON.stringify(line.slice(0, 120))}`);
  }
  const sorted = [...lines].sort();
  need(new Set(sorted).size === sorted.length, "the tested tag set repeats a ref");
  return sha256(sorted.length === 0 ? "" : `${sorted.join("\n")}\n`);
}

// ── shared run facts ────────────────────────────────────────────────────────

function checkJob(job, attempt, where) {
  need(isObject(job) && isInt(job.id) && typeof job.name === "string" && job.name.length > 0,
    `${where}: a job has no id or name`);
  need(job.run_attempt === attempt, `${where}: job ${job.id} is from attempt ${job.run_attempt}, want ${attempt}`);
  need(Array.isArray(job.labels) && job.labels.every((l) => typeof l === "string"), `${where}: job ${job.id} has malformed labels`);
}

/** A run's attempt, its jobs (all pages), and the uniqueness the rest relies on. */
async function attemptJobs(api, repository, runId, attempt, where) {
  const jobs = await listCounted(api, `repos/${repository}/actions/runs/${runId}/attempts/${attempt}/jobs`, "jobs", LIMITS.jobs);
  for (const job of jobs) checkJob(job, attempt, where);
  need(new Set(jobs.map((j) => j.id)).size === jobs.length, `${where}: the job inventory repeats a job id`);
  need(new Set(jobs.map((j) => j.name)).size === jobs.length, `${where}: the job inventory repeats a job name`);
  return jobs;
}

/** The referenced workflows of a merge-gate pull_request run, all at one merge SHA. */
function mergeRefOf(run, repository, prNumber) {
  return referencedAt(run, repository, `refs/pull/${prNumber}/merge`);
}

/** The referenced workflows of a merge-gate run, all at one SHA on exactly `ref`. */
function referencedAt(run, repository, ref) {
  const refs = run.referenced_workflows;
  need(Array.isArray(refs) && refs.length > 0 && refs.length <= LIMITS.referencedWorkflows,
    "the run reports no referenced workflows, so what it checked out is unknown");
  const shas = new Set();
  for (const r of refs) {
    need(isObject(r) && typeof r.path === "string" && HEX40.test(r.sha ?? "") && r.ref === ref,
      `a referenced workflow is not ${ref}: ${JSON.stringify(r).slice(0, 200)}`);
    need(r.path.startsWith(`${repository}/.github/workflows/`) && r.path.endsWith(`@${r.sha}`),
      `a referenced workflow is not from this repository at its own SHA: ${r.path}`);
    shas.add(r.sha);
  }
  need(shas.size === 1, "the referenced workflows disagree on the commit they ran");
  need(new Set(refs.map((r) => r.path)).size === refs.length, "a referenced workflow is listed twice");
  const sorted = refs.map((r) => ({ path: r.path, sha: r.sha, ref: r.ref }))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { sha: [...shas][0], ref, refs: sorted };
}

// ── produce ─────────────────────────────────────────────────────────────────

/**
 * The manifest for the run this process is part of. Throws `NoReuse` when the
 * run cannot be described completely; the caller then writes nothing.
 */
export async function produce({ env, api, git, registry, now, workflowsDir, readFile = readRepoFile, loadScope = importScope }) {
  const dispatched = env.GITHUB_EVENT_NAME === "workflow_dispatch";
  need(env.GITHUB_EVENT_NAME === "pull_request" || dispatched,
    `event ${env.GITHUB_EVENT_NAME} produces no proof; only pull_request runs and frozen release-metadata dispatches do`);
  if (dispatched && env.CI_EVIDENCE_DISPATCH_MODE === INTERNAL_MODE) {
    return produceInternal({ env, api, git, registry, now, workflowsDir, readFile, loadScope });
  }
  if (dispatched) return produceDispatch({ env, api, git, registry, now, workflowsDir, readFile, loadScope });
  const repository = env.GITHUB_REPOSITORY;
  const repositoryId = envInt(env.GITHUB_REPOSITORY_ID);
  const runId = envInt(env.GITHUB_RUN_ID);
  const attempt = envInt(env.GITHUB_RUN_ATTEMPT);
  need(isInt(repositoryId) && isInt(runId) && isInt(attempt) && /^[^/]+\/[^/]+$/.test(repository ?? ""),
    "the runner did not describe this run");
  let event;
  try { event = JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, "utf8")); } catch (err) { fail(`the event payload is unreadable: ${err.message}`); }
  const pr = event?.pull_request;
  need(isObject(pr) && isInt(pr.number) && HEX40.test(pr.head?.sha ?? "") && HEX40.test(pr.base?.sha ?? "")
    && isInt(pr.head?.repo?.id) && isInt(pr.base?.repo?.id), "the event payload has no usable pull_request");
  need(pr.base.repo.id === repositoryId, "the pull request's base is another repository");

  const head = headFacts(git);
  need(head.sha === env.GITHUB_SHA, `checked out ${head.sha}, the run is for ${env.GITHUB_SHA}`);
  need(head.parents.length === 2, "the checkout is not a two-parent merge commit");
  need(head.parents[1] === pr.head.sha, "the merge commit's second parent is not the pull request head");

  const run = await api.json(`repos/${repository}/actions/runs/${runId}`);
  need(run.id === runId && run.run_attempt === attempt && run.event === "pull_request"
    && run.path === ".github/workflows/merge-gate.yml" && run.head_sha === pr.head.sha,
  "the API's view of this run disagrees with the runner's");
  const merge = mergeRefOf(run, repository, pr.number);
  need(merge.sha === head.sha, `the referenced workflows ran ${merge.sha}, this checkout is ${head.sha}`);
  need(env.GITHUB_WORKFLOW_SHA === head.sha, "the gate's own workflow file is not from the merge commit");

  const facts = await judgedRunFacts({ env, api, git, registry, workflowsDir, repository, runId, attempt });
  const manifest = {
    schema: MANIFEST_SCHEMA,
    kind: MANIFEST_KIND,
    produced_at: isoSeconds(now()),
    repository: { id: repositoryId, full_name: repository },
    pull_request: {
      number: pr.number, head_sha: pr.head.sha, base_sha: pr.base.sha, base_ref: String(pr.base.ref),
      head_repository_id: pr.head.repo.id, same_repository: pr.head.repo.id === repositoryId,
    },
    dispatch: null,
    run: {
      id: runId, attempt, event: "pull_request", workflow_path: run.path,
      workflow_ref: String(env.GITHUB_WORKFLOW_REF), workflow_sha: env.GITHUB_WORKFLOW_SHA,
    },
    checkout: { sha: head.sha, tree: head.tree, ref: merge.ref, parents: head.parents },
    referenced_workflows: merge.refs,
    ...facts,
    certification: certificationOf(readFile),
    toolchain: producerToolchain(env),
  };
  need(manifest.pull_request.same_repository, "a fork pull request produces no proof");
  return validateManifest(manifest);
}

/**
 * The frozen release-metadata dispatch: the gate checked out the candidate SHA
 * itself, one commit on the CURRENT protected main, on the macOS release lane's
 * candidate branch, judged by BASE's whitelist (the select job). The candidate
 * may not touch the gate's own inputs. Main later fast-forwards to exactly it.
 */
async function produceDispatch({ env, api, git, registry, now, workflowsDir, readFile, loadScope }) {
  const repository = env.GITHUB_REPOSITORY;
  const repositoryId = envInt(env.GITHUB_REPOSITORY_ID);
  const runId = envInt(env.GITHUB_RUN_ID);
  const attempt = envInt(env.GITHUB_RUN_ATTEMPT);
  need(isInt(repositoryId) && isInt(runId) && isInt(attempt) && /^[^/]+\/[^/]+$/.test(repository ?? ""),
    "the runner did not describe this run");
  need(env.CI_EVIDENCE_DISPATCH_MODE === DISPATCH_MODE,
    `dispatch mode ${JSON.stringify(env.CI_EVIDENCE_DISPATCH_MODE ?? null)} produces no proof; only ${DISPATCH_MODE} does`);
  need(FROZEN_REF.test(env.GITHUB_REF ?? ""), `${env.GITHUB_REF} is not a frozen release-candidate branch`);
  const base = env.CI_EVIDENCE_DISPATCH_BASE;
  const candidate = env.CI_EVIDENCE_DISPATCH_HEAD;
  need(HEX40.test(base ?? "") && HEX40.test(candidate ?? ""), "the dispatch did not name a base and a head SHA");
  const head = headFacts(git);
  need(head.sha === candidate && env.GITHUB_SHA === candidate, `checked out ${head.sha}, the dispatch is for ${candidate}`);
  need(head.parents.length === 1 && head.parents[0] === base, "the candidate is not exactly one commit on the dispatched base");
  need(env.GITHUB_WORKFLOW_SHA === candidate, "the gate's own workflow file is not from the candidate");
  const mainRef = await api.json(`repos/${repository}/git/ref/heads/main`);
  need(mainRef?.object?.sha === base, `main is at ${mainRef?.object?.sha}, not the candidate's base ${base}`);
  const scope = await frozenCandidateScope({ api, repository, base, candidate, ref: env.GITHUB_REF, readFile, loadScope });
  const run = await api.json(`repos/${repository}/actions/runs/${runId}`);
  need(run.id === runId && run.run_attempt === attempt && run.event === "workflow_dispatch"
    && run.path === ".github/workflows/merge-gate.yml" && run.head_sha === candidate
    && `refs/heads/${run.head_branch}` === env.GITHUB_REF && run.head_repository?.id === repositoryId,
  "the API's view of this dispatch disagrees with the runner's");
  const at = referencedAt(run, repository, env.GITHUB_REF);
  need(at.sha === candidate, `the referenced workflows ran ${at.sha}, this checkout is ${candidate}`);
  const facts = await judgedRunFacts({ env, api, git, registry, workflowsDir, repository, runId, attempt });
  return validateManifest({
    schema: MANIFEST_SCHEMA,
    kind: DISPATCH_KIND,
    produced_at: isoSeconds(now()),
    repository: { id: repositoryId, full_name: repository },
    pull_request: null,
    dispatch: { mode: DISPATCH_MODE, base_sha: base, head_sha: candidate, ref: env.GITHUB_REF, ...scope },
    run: {
      id: runId, attempt, event: "workflow_dispatch", workflow_path: run.path,
      workflow_ref: String(env.GITHUB_WORKFLOW_REF), workflow_sha: env.GITHUB_WORKFLOW_SHA,
    },
    checkout: { sha: head.sha, tree: head.tree, ref: env.GITHUB_REF, parents: head.parents },
    referenced_workflows: at.refs,
    ...facts,
    certification: certificationOf(readFile),
    toolchain: producerToolchain(env),
  });
}

/** git's blob id for `bytes` (what the contents API reports as `sha`). */
const gitBlobSha = (bytes) => createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");

/**
 * The frozen candidate `base`→`candidate`, judged independently of the mode name
 * and of protected main: exactly one commit, a bounded change set (both sides of
 * every rename) that touches no gate input, that BASE's release-metadata
 * whitelist accepts as a complete candidate — exactly `CANDIDATE_PATHS` plus,
 * optionally, only the sitemap — judged by a whitelist module the candidate did
 * not change and whose bytes here are BASE's, and whose `web/native-releases.json`
 * names the branch's macOS version. Returns what the proof records.
 */
async function frozenCandidateScope({ api, repository, base, candidate, ref, readFile, loadScope }) {
  const branch = FROZEN_REF.exec(ref ?? "");
  need(branch !== null, `${ref} is not a frozen release-candidate branch`);
  const cmp = await api.json(`repos/${repository}/compare/${base}...${candidate}`);
  need(cmp?.status === "ahead" && cmp.ahead_by === 1 && cmp.behind_by === 0 && Array.isArray(cmp.files)
    && cmp.files.length > 0 && cmp.files.length < 300, "the compare API does not show exactly one commit of a bounded change");
  const paths = new Set();
  for (const f of cmp.files) {
    need(isObject(f) && typeof f.filename === "string" && f.filename.length > 0, "the compare API lists a file without a name");
    for (const path of [f.filename, f.previous_filename].filter((x) => x !== undefined && x !== null)) {
      need(typeof path === "string" && !DISPATCH_FORBIDDEN(path) && !CONTROL_FILES.includes(path),
        `the candidate touches ${JSON.stringify(path)}, a gate input; its run can never be a proof`);
      paths.add(path);
    }
  }
  need(!paths.has(SCOPE_FILE), `the candidate changes ${SCOPE_FILE}, the whitelist that judges it`);
  let scopeBytes;
  try { scopeBytes = Buffer.from(readFile(SCOPE_FILE)); } catch (err) { fail(`${SCOPE_FILE} is unreadable: ${err.message}`); }
  const baseBlob = await api.json(`repos/${repository}/contents/${SCOPE_FILE}?ref=${base}`);
  need(isObject(baseBlob) && baseBlob.type === "file" && baseBlob.path === SCOPE_FILE && baseBlob.sha === gitBlobSha(scopeBytes),
    `the ${SCOPE_FILE} checked out here is not BASE ${base}'s`);
  let verdict;
  try {
    const scope = await loadScope();
    need(typeof scope?.checkCandidateScope === "function" && Array.isArray(scope.CANDIDATE_PATHS) && scope.CANDIDATE_PATHS.length > 0,
      `${SCOPE_FILE} does not export the release-metadata whitelist`);
    verdict = scope.checkCandidateScope([...paths].sort(), { alreadyDelivered: false });
  } catch (err) {
    if (err instanceof NoReuse) throw err;
    fail(`BASE's release-metadata whitelist could not judge the candidate: ${err.message}`);
  }
  need(isObject(verdict) && verdict.ok === true && Array.isArray(verdict.problems) && verdict.problems.length === 0,
    `BASE's release-metadata whitelist refuses the candidate: ${(verdict?.problems ?? ["no verdict"]).join("; ")}`);
  need(paths.has(NATIVE_RELEASES_FILE), `the candidate does not change ${NATIVE_RELEASES_FILE}`);
  let releases;
  try { releases = JSON.parse(Buffer.from(readFile(NATIVE_RELEASES_FILE)).toString("utf8")); } catch (err) {
    fail(`${NATIVE_RELEASES_FILE} is unreadable: ${err.message}`);
  }
  need(releases?.macos?.version === branch[1],
    `the candidate's ${NATIVE_RELEASES_FILE} names macOS ${JSON.stringify(releases?.macos?.version ?? null)}, its branch ${branch[1]}`);
  return { version: branch[1], paths: [...paths].sort(), scope_sha256: sha256(scopeBytes) };
}

// ── the internal full candidate ─────────────────────────────────────────────

const ENTRY = /^([0-7]{6}) (blob|commit) ([0-9a-f]{40})$/;

/** Every non-tree entry of HEAD's tree as `mode type object`, read from git — no file is opened. */
function localTree(git) {
  const out = new Map();
  for (const line of git(["ls-tree", "-r", "-z", "--full-tree", "HEAD"]).toString("utf8").split("\0")) {
    if (line === "") continue;
    const tab = line.indexOf("\t");
    need(tab > 0 && ENTRY.test(line.slice(0, tab)), `git ls-tree printed an unreadable entry ${JSON.stringify(line.slice(0, 120))}`);
    out.set(line.slice(tab + 1), line.slice(0, tab));
  }
  need(out.size > 0, "git ls-tree listed nothing");
  return out;
}

/** A commit and its complete, untruncated tree as the API reports them (`mode type object` per path). */
async function apiTree(api, repository, sha, what) {
  const commit = await api.json(`repos/${repository}/git/commits/${sha}`);
  need(isObject(commit) && commit.sha === sha && HEX40.test(commit.tree?.sha ?? "") && Array.isArray(commit.parents)
    && commit.parents.every((p) => HEX40.test(p?.sha ?? "")), `the API's ${what} ${sha} is not a commit`);
  const tree = await api.json(`repos/${repository}/git/trees/${commit.tree.sha}?recursive=1`);
  need(isObject(tree) && tree.sha === commit.tree.sha && tree.truncated === false && Array.isArray(tree.tree),
    `the API's tree of the ${what} ${sha} is truncated or malformed`);
  const entries = new Map();
  for (const e of tree.tree) {
    need(isObject(e) && typeof e.path === "string" && e.path.length > 0, `the API's tree of the ${what} lists an entry without a path`);
    if (e.type === "tree") continue;
    const entry = `${e.mode} ${e.type} ${e.sha}`;
    need(ENTRY.test(entry) && !entries.has(e.path), `the API's tree of the ${what} lists ${JSON.stringify(e.path)} malformed or twice`);
    entries.set(e.path, entry);
  }
  return { commit, entries };
}

const MODULE = /\.(mjs|js)$/;

/**
 * The repository modules `text` (the module at `path`) loads: static and
 * re-export specifiers that are relative, a literal relative dynamic load, and
 * the two repository-root shapes this tree uses — a literal path, or a
 * same-file string constant — passed through `pathToFileURL(resolve|join(root, …))`.
 * Any other dynamic load is a module this closure cannot name, and that is a
 * refusal: an underived closure is an incomplete one.
 */
export function moduleImports(path, text, exists) {
  const out = new Set();
  // A relative specifier starts with "." (a bare one names a package, outside the
  // repository). A path that climbs out of the tree is not a tracked file, so
  // `exists` already drops it.
  const relative = (spec) => {
    if (!spec.startsWith(".")) return;
    const target = posix.normalize(posix.join(posix.dirname(path), spec));
    if (exists(target)) out.add(target);
  };
  for (const m of text.matchAll(/\bfrom\s*["']([^"'\n]+)["']/g)) relative(m[1]);
  for (const m of text.matchAll(/\bimport\s*["']([^"'\n]+)["']/g)) relative(m[1]);
  for (const m of text.matchAll(/\bimport\(\s*([^\n]*)/g)) {
    const arg = m[1];
    const literal = /^["']([^"'\n]+)["']/.exec(arg);
    if (literal) { if (!literal[1].startsWith("node:")) relative(literal[1]); continue; }
    const rooted = /^pathToFileURL\(\s*(?:resolve|join)\(\s*[A-Za-z_$][\w$]*\s*,\s*(?:["']([^"'\n]+)["']|([A-Z][A-Z0-9_]*))\s*\)\s*\)/.exec(arg);
    let target = rooted?.[1];
    if (rooted?.[2]) target = new RegExp(`\\bconst ${rooted[2]} = "([^"\\n]+)";`).exec(text)?.[1];
    need(typeof target === "string" && exists(target),
      `${path} loads a module this trust closure cannot name (${oneLine(arg).slice(0, 80)})`);
    out.add(target);
  }
  return [...out];
}

/**
 * The trust closure of an internal full candidate, derived from BASE's tree,
 * refusing as soon as the candidate touches a member. `changed` is the
 * candidate's complete change set (both sides of every rename); every file it
 * does not list is BASE's, so reading it here reads BASE. Returns the closure,
 * each member byte-compared with BASE's blob.
 */
async function internalTrustClosure({ api, repository, baseEntries, localEntries, changed, readFile, loadScope }) {
  const closure = new Map();
  const member = (path, why) => {
    need(!changed.has(path), `the candidate touches ${JSON.stringify(path)}, a trust input (${why}); its run can never be a proof`);
    if (!closure.has(path)) closure.set(path, why);
  };
  const everyPath = [...new Set([...baseEntries.keys(), ...localEntries.keys(), ...changed])].sort();

  // 1. The gate's workflows, the CI machinery and the release helpers, whole;
  //    the selector's own control files; the release-metadata whitelist.
  for (const path of everyPath) {
    const prefix = TRUST_PREFIXES.find((p) => path.startsWith(p));
    if (prefix) member(path, `under ${prefix}`);
  }
  for (const path of CONTROL_FILES) member(path, "a merge-gate control file");
  member(SCOPE_FILE, "the release-metadata whitelist");

  // 2. Every module that machinery executes, transitively — the toolchain probe
  //    loads the browser harness, and the harness its own helpers. Walked from
  //    the machinery, not from the tests: a test module is itself a member (it
  //    is a control file or a guard below) and is judged by running it.
  const exists = (p) => baseEntries.has(p);
  const queue = [...closure.keys()].filter((p) => MODULE.test(p) && exists(p) && !p.startsWith(".github/") && !p.startsWith(GUARD_DIR));
  for (let i = 0; i < queue.length; i += 1) {
    const from = queue[i];
    for (const path of moduleImports(from, Buffer.from(readFile(from)).toString("utf8"), exists)) {
      if (closure.has(path)) continue;
      member(path, `loaded by ${from}`);
      if (MODULE.test(path)) queue.push(path);
    }
  }

  // 3. The macOS release files written from the signed build's own upload:
  //    only the frozen release-metadata mode may carry them.
  let artifactFiles;
  try { artifactFiles = (await loadScope()).RELEASE_ARTIFACT_FILES; } catch (err) {
    fail(`BASE's ${SCOPE_FILE} could not be loaded: ${err.message}`);
  }
  need(Array.isArray(artifactFiles) && artifactFiles.length > 0 && artifactFiles.every((p) => typeof p === "string" && p.length > 0),
    `${SCOPE_FILE} does not export RELEASE_ARTIFACT_FILES`);
  for (const path of artifactFiles) member(path, "an artifact-derived macOS release file");

  // 4. The workflow guards: a file under scripts/test/ whose BASE or candidate
  //    bytes read `.github/`. A changed one is judged on both sides.
  for (const path of everyPath.filter((p) => p.startsWith(GUARD_DIR))) {
    const sides = [];
    if (changed.has(path)) {
      const before = baseEntries.get(path);
      if (before) sides.push(await baseBlob(api, repository, before, path));
      if (localEntries.has(path)) sides.push(Buffer.from(readFile(path)));
    } else {
      sides.push(Buffer.from(readFile(path)));
    }
    if (sides.some((bytes) => bytes.includes(GUARD_MARK))) member(path, "a workflow guard");
  }

  // 5. Byte for byte: what this checkout would execute IS BASE's.
  for (const [path] of closure) {
    const before = baseEntries.get(path);
    need(before === localEntries.get(path), `the candidate's ${path} is not BASE's`);
    if (before === undefined || !before.startsWith("100")) continue;
    let bytes;
    try { bytes = Buffer.from(readFile(path)); } catch (err) { fail(`${path} is unreadable: ${err.message}`); }
    need(gitBlobSha(bytes) === before.slice(-40), `the ${path} checked out here is not BASE's blob`);
  }
  return closure;
}

/** BASE's bytes of one blob, through the API, checked against its object id. */
async function baseBlob(api, repository, entry, path) {
  const oid = entry.slice(-40);
  const blob = await api.json(`repos/${repository}/git/blobs/${oid}`);
  need(isObject(blob) && blob.sha === oid && blob.encoding === "base64" && typeof blob.content === "string"
    && Number.isSafeInteger(blob.size) && blob.size <= BLOB_MAX, `BASE's ${path} is unreadable through the API`);
  const bytes = Buffer.from(blob.content, "base64");
  need(gitBlobSha(bytes) === oid, `BASE's ${path} from the API is not its own blob`);
  return bytes;
}

/**
 * The internal full candidate `base`→`candidate` on `ref`, judged without
 * trusting the mode name or protected main: one commit, on its own branch, whose
 * change set the compare API AND this checkout's tree against BASE's API tree
 * both report identically (renames as both paths, mode changes included), and
 * which touches no member of BASE's trust closure. Returns what the proof records.
 */
async function internalCandidateScope({ api, repository, base, candidate, ref, git, readFile, loadScope }) {
  need(HEX40.test(base ?? "") && HEX40.test(candidate ?? "") && base !== candidate, "the candidate does not name a distinct base and head SHA");
  need(INTERNAL_REF.exec(ref ?? "")?.[1] === candidate, `${ref} is not internal-candidate/${candidate}, the branch of exactly this candidate`);
  const head = headFacts(git);
  need(head.sha === candidate && head.parents.length === 1 && head.parents[0] === base,
    "the checkout is not the candidate exactly one commit on its base");

  const cmp = await api.json(`repos/${repository}/compare/${base}...${candidate}`);
  need(cmp?.status === "ahead" && cmp.ahead_by === 1 && cmp.behind_by === 0 && Array.isArray(cmp.files)
    && cmp.files.length > 0 && cmp.files.length < 300, "the compare API does not show exactly one commit of a bounded change");
  const compared = new Set();
  for (const f of cmp.files) {
    need(isObject(f) && typeof f.filename === "string" && f.filename.length > 0, "the compare API lists a file without a name");
    for (const path of [f.filename, f.previous_filename].filter((x) => x !== undefined && x !== null)) {
      need(typeof path === "string" && path.length > 0, "the compare API lists a malformed previous name");
      compared.add(path);
    }
  }

  const { commit: baseCommit, entries: baseEntries } = await apiTree(api, repository, base, "base");
  need(baseCommit.sha === base, "the API's base is another commit");
  const cand = await api.json(`repos/${repository}/git/commits/${candidate}`);
  need(isObject(cand) && cand.sha === candidate && cand.tree?.sha === head.tree && Array.isArray(cand.parents)
    && cand.parents.length === 1 && cand.parents[0]?.sha === base, "the API's view of the candidate is not this checkout's tree on its base");
  const localEntries = localTree(git);
  const changed = new Set();
  for (const path of new Set([...baseEntries.keys(), ...localEntries.keys()])) {
    if (baseEntries.get(path) !== localEntries.get(path)) changed.add(path);
  }
  need(changed.size > 0, "the candidate changes nothing");
  const onlyTree = [...changed].filter((p) => !compared.has(p));
  const onlyCompare = [...compared].filter((p) => !changed.has(p));
  need(onlyTree.length === 0 && onlyCompare.length === 0, "the compare API and this checkout's tree against BASE's disagree on "
    + `the change set (tree only: ${onlyTree.slice(0, 3).join(", ") || "-"}; compare only: ${onlyCompare.slice(0, 3).join(", ") || "-"})`);

  const closure = await internalTrustClosure({ api, repository, baseEntries, localEntries, changed, readFile, loadScope });
  const lines = [...closure.keys()].sort().map((p) => `${p} ${baseEntries.get(p) ?? "absent"}`);
  return { paths: [...changed].sort(), closure_sha256: sha256(`${lines.join("\n")}\n`), closure: [...closure.keys()].sort() };
}

/** main is exactly `base` and the candidate's branch is exactly `candidate`, now. */
async function internalPinned(api, repository, base, candidate) {
  const mainRef = await api.json(`repos/${repository}/git/ref/heads/main`);
  need(mainRef?.object?.sha === base, `main is at ${mainRef?.object?.sha}, not the candidate's base ${base}`);
  const branch = await api.json(`repos/${repository}/git/ref/heads/internal-candidate/${candidate}`);
  need(branch?.object?.sha === candidate, `internal-candidate/${candidate} points at ${branch?.object?.sha}, not its own candidate`);
}

/**
 * merge-gate's `internal-full-candidate` select step, run as BASE's copy of
 * this file from a BASE worktree against the candidate checkout. Every
 * condition is a hard stop: the select job fails, and so does the gate.
 * Besides the shared judgement it derives the change set a third way, from the
 * local objects the select job's depth-2 checkout holds.
 */
export async function judgeInternalCandidate({ env, api, git, readFile, loadScope = importScope }) {
  need(env.GITHUB_EVENT_NAME === "workflow_dispatch", "the internal full candidate mode is reachable only by workflow_dispatch");
  need(env.MODE === INTERNAL_MODE, `mode is ${JSON.stringify(env.MODE ?? null)}, not ${INTERNAL_MODE}`);
  const base = env.EXPECTED_BASE;
  const candidate = env.EXPECTED_HEAD;
  need(HEX40.test(base ?? "") && HEX40.test(candidate ?? ""), "base_sha and head_sha must be full lowercase SHAs");
  need(env.GITHUB_SHA === candidate, `this run checked out ${env.GITHUB_SHA}, not head_sha ${candidate}`);
  const repository = env.GITHUB_REPOSITORY;
  need(/^[^/]+\/[^/]+$/.test(repository ?? ""), "the runner did not name the repository");
  await internalPinned(api, repository, base, candidate);
  const scope = await internalCandidateScope({ api, repository, base, candidate, ref: env.GITHUB_REF, git, readFile, loadScope });
  const local = git(["diff-tree", "-r", "-z", "--no-commit-id", "--no-renames", "--name-only", base, candidate])
    .toString("utf8").split("\0").filter((p) => p !== "").sort();
  need(JSON.stringify([...new Set(local)]) === JSON.stringify(scope.paths),
    "git's own diff of the candidate against BASE disagrees with the API-derived change set");
  return scope;
}

/**
 * The internal full candidate's proof: the gate checked out the candidate on
 * its own `internal-candidate/<sha>` branch, every lane selected and passed,
 * main is still its base and the branch still names it — read before and after
 * everything else.
 */
async function produceInternal({ env, api, git, registry, now, workflowsDir, readFile, loadScope }) {
  const repository = env.GITHUB_REPOSITORY;
  const repositoryId = envInt(env.GITHUB_REPOSITORY_ID);
  const runId = envInt(env.GITHUB_RUN_ID);
  const attempt = envInt(env.GITHUB_RUN_ATTEMPT);
  need(isInt(repositoryId) && isInt(runId) && isInt(attempt) && /^[^/]+\/[^/]+$/.test(repository ?? ""),
    "the runner did not describe this run");
  const base = env.CI_EVIDENCE_DISPATCH_BASE;
  const candidate = env.CI_EVIDENCE_DISPATCH_HEAD;
  need(HEX40.test(base ?? "") && HEX40.test(candidate ?? ""), "the dispatch did not name a base and a head SHA");
  need(INTERNAL_REF.exec(env.GITHUB_REF ?? "")?.[1] === candidate,
    `${env.GITHUB_REF} is not internal-candidate/${candidate}, the branch of exactly this candidate`);
  const head = headFacts(git);
  need(head.sha === candidate && env.GITHUB_SHA === candidate, `checked out ${head.sha}, the dispatch is for ${candidate}`);
  need(head.parents.length === 1 && head.parents[0] === base, "the candidate is not exactly one commit on the dispatched base");
  need(env.GITHUB_WORKFLOW_SHA === candidate, "the gate's own workflow file is not from the candidate");
  await internalPinned(api, repository, base, candidate);
  const scope = await internalCandidateScope({ api, repository, base, candidate, ref: env.GITHUB_REF, git, readFile, loadScope });
  const run = await api.json(`repos/${repository}/actions/runs/${runId}`);
  need(run.id === runId && run.run_attempt === attempt && run.event === "workflow_dispatch"
    && run.path === ".github/workflows/merge-gate.yml" && run.head_sha === candidate
    && `refs/heads/${run.head_branch}` === env.GITHUB_REF && run.head_repository?.id === repositoryId,
  "the API's view of this dispatch disagrees with the runner's");
  const at = referencedAt(run, repository, env.GITHUB_REF);
  need(at.sha === candidate, `the referenced workflows ran ${at.sha}, this checkout is ${candidate}`);
  const facts = await judgedRunFacts({ env, api, git, registry, workflowsDir, repository, runId, attempt });
  const partial = Object.entries(facts.lanes).filter(([, l]) => !l.selected).map(([id]) => id);
  need(partial.length === 0, `an internal full candidate ran without ${partial.join(", ")}; only a run of every lane is its proof`);
  await internalPinned(api, repository, base, candidate);
  return validateManifest({
    schema: INTERNAL_SCHEMA,
    kind: INTERNAL_KIND,
    produced_at: isoSeconds(now()),
    repository: { id: repositoryId, full_name: repository },
    pull_request: null,
    dispatch: { mode: INTERNAL_MODE, base_sha: base, head_sha: candidate, ref: env.GITHUB_REF, paths: scope.paths,
      closure_sha256: scope.closure_sha256 },
    run: {
      id: runId, attempt, event: "workflow_dispatch", workflow_path: run.path,
      workflow_ref: String(env.GITHUB_WORKFLOW_REF), workflow_sha: env.GITHUB_WORKFLOW_SHA,
    },
    checkout: { sha: head.sha, tree: head.tree, ref: env.GITHUB_REF, parents: head.parents },
    referenced_workflows: at.refs,
    ...facts,
    certification: certificationOf(readFile),
    toolchain: producerToolchain(env),
  });
}

const certificationOf = (readFile) => ({
  registry_sha256: sha256(readFile(REGISTRY_FILE)),
  verifier_sha256: sha256(readFile(VERIFIER_FILE)),
  selector_sha256: sha256(readFile(SELECTOR_FILE)),
  toolchain_sha256: sha256(readFile(TOOLCHAIN_FILE)),
  toolchain_registry_sha256: sha256(readFile(TOOLCHAIN_REGISTRY_FILE)),
});

const producerToolchain = (env) => ({
  runner_os: String(env.RUNNER_OS ?? ""), runner_arch: String(env.RUNNER_ARCH ?? ""),
  image_os: String(env.ImageOS ?? ""), image_version: String(env.ImageVersion ?? ""), node: process.version,
});

/** The judged lanes, every job of this attempt, and the per-lane input fingerprints. */
async function judgedRunFacts({ env, api, git, registry, workflowsDir, repository, runId, attempt }) {
  let needs;
  let selected;
  try {
    needs = JSON.parse(env.CI_EVIDENCE_NEEDS);
    selected = JSON.parse(env.CI_EVIDENCE_SELECTED);
  } catch (err) { fail(`the gate's needs/selection are not JSON: ${err.message}`); }
  const lanes = {};
  for (const lane of SELECTOR_LANES) {
    const sel = selected?.[lane.id];
    need(sel === "true" || sel === "false", `the selection of ${lane.id} is ${JSON.stringify(sel)}`);
    lanes[lane.id] = { selected: sel === "true", result: String(needs?.[lane.id]?.result) };
  }
  for (const id of UNCONDITIONAL_LANES) lanes[id] = { selected: true, result: String(needs?.[id]?.result) };
  for (const [id, lane] of Object.entries(lanes)) {
    need(lane.selected ? lane.result === "success" : lane.result === "skipped",
      `lane ${id} is selected=${lane.selected} with result ${lane.result}; the gate would not have passed`);
  }

  const jobs = await attemptJobs(api, repository, runId, attempt, "this run");
  const aggregate = jobs.filter((j) => j.name === registry.producer.aggregateJob);
  need(aggregate.length === 1, "this run does not list exactly one aggregate job");
  const others = jobs.filter((j) => j.name !== registry.producer.aggregateJob);
  for (const job of others) {
    need(job.status === "completed" && typeof job.conclusion === "string",
      `job ${JSON.stringify(job.name)} has not completed (${job.status})`);
  }

  const fingerprints = {};
  for (const [id, lane] of Object.entries(registry.lanes)) {
    if (lanes[id]?.selected) fingerprints[id] = laneFingerprint(git, id, lane, workflowsDir);
  }
  return {
    lanes,
    jobs: others.map((j) => ({ id: j.id, name: j.name, status: j.status, conclusion: j.conclusion, labels: j.labels }))
      .sort((a, b) => a.id - b.id),
    fingerprints,
  };
}

// ── witness ─────────────────────────────────────────────────────────────────

/** The check names the CURRENT main push requires from the source run. */
/**
 * The ONE runner `job` must have reported in a source run of `sourceEvent`:
 * `dispatchRunner` for a `workflow_dispatch` source when the registry names
 * one, else `runner`. `sourceEvent` is the event the verifier re-read from the
 * API for the source run and bound to its kind, never a caller's claim.
 */
export function expectedRunner(job, sourceEvent) {
  need(sourceEvent === "pull_request" || sourceEvent === "workflow_dispatch",
    `a source run of event ${JSON.stringify(sourceEvent)} selects no runner`);
  return sourceEvent === "workflow_dispatch" && job.dispatchRunner !== undefined ? job.dispatchRunner : job.runner;
}

export function requiredJobs(lane, scopeValue) {
  const gated = new Set(lane.scope && scopeValue === "false" ? lane.scope.gates : []);
  const out = {};
  for (const [jobId, job] of Object.entries(lane.jobs)) {
    if (gated.has(jobId)) continue;
    out[jobId] = job.checks;
  }
  return out;
}

/**
 * The run that executed LAST: greatest (run_started_at, created_at, id). A re-run
 * keeps its id and `created_at` but gets a new `run_started_at`, so ordering by
 * creation would let an older run's later, failed re-run hide behind a newer
 * run's earlier success (the same rule scripts/release/go-evidence.sh uses).
 */
const executionKey = (r) => [r.run_started_at, r.created_at, String(r.id).padStart(20, "0")];
export const newest = (runs) => [...runs].sort((a, b) => {
  const ka = executionKey(a);
  const kb = executionKey(b);
  for (let i = 0; i < ka.length; i += 1) if (ka[i] !== kb[i]) return ka[i] < kb[i] ? -1 : 1;
  return 0;
}).at(-1);

/** What a re-read of the run listing must find unchanged. */
const runListing = (runs) => JSON.stringify([...runs].map((r) => [r.id, r.run_attempt, r.status, r.conclusion,
  r.event, r.run_started_at, r.created_at]).sort((a, b) => a[0] - b[0]));

/**
 * Steps 2-8 of `witness`, shared READ-ONLY with the macOS release reader: the
 * one source this main commit may reuse (pull request, frozen or internal
 * candidate), its latest attempt and every job of it, this lane's obligation,
 * and the one immutable proof artifact agreeing with all of that. `head` and
 * the injected `git`/`readFile`/`readWorkflow` must describe the SAME commit
 * `sha`; `event.before` is its sole parent where a dispatch source needs one.
 * Throws `NoReuse` on any doubt and writes nothing.
 */
export async function judgeSourceProof(args) {
  return judgeProof(args, null);
}

/**
 * The HISTORICAL form of `judgeSourceProof`, for the macOS release reader's
 * later verification of a chain a main witness `W` already certified. Library
 * only (never reachable from `main`). Same judgement, same arguments, plus the
 * authenticated `witness`:
 *  - `validateWitness`, and its target is this lane (macOS only), repository,
 *    commit and tree; lanes with `externalInputs` are refused here (a later tag
 *    would change what the original test saw — not specified historically);
 *  - the selected source (kind, PR, head, merge, run, attempt, proof id, digest,
 *    produced_at) must be EXACTLY the witness's source BEFORE any age gate;
 *  - the two ORIGINAL age gates (source run updated, proof produced) are judged
 *    at `eligibleAt` = W.verified_at, derived here — no caller timestamp — which
 *    must itself not be in the future of the machine clock; a failure there
 *    contradicts the witness and is plain `NoReuse`, never `ProofUnavailable`;
 *  - everything else (artifact expiry, records, listings, jobs, tree, parents,
 *    scope, fingerprint, the five hashes) is judged at the machine `now()`.
 */
export async function judgeHistoricalSourceProof({ witness: w, ...args }) {
  let checked;
  try { checked = validateWitness(w); } catch (err) { fail(`the historical witness is not valid: ${err.message}`); }
  need(args.laneId === "macos" && checked.lane === "macos", `historical source proofs are specified for the macos lane only`);
  need(checked.target.repository_id === args.repositoryId && checked.target.sha === args.sha
    && checked.target.sha === args.head?.sha && checked.target.tree === args.head?.tree,
  `the witness targets ${checked.target.sha}/${checked.target.tree}, not ${args.sha}/${args.head?.tree}`);
  const eligibleAt = Date.parse(checked.verified_at);
  need(Number.isFinite(eligibleAt) && eligibleAt <= args.now().getTime() + LIMITS.clockSkewMs,
    `the witness says it was verified at ${checked.verified_at}, in the future of this machine's clock`);
  return judgeProof(args, { witness: checked, eligibleAt });
}

async function judgeProof({
  api, git, registry, laneId, repository, repositoryId, sha, head, event, now, workflowsDir, readFile = readRepoFile,
  loadScope = importScope, scopeValue, readWorkflow,
}, history) {
  const lane = registry.lanes[laneId];
  need(lane !== undefined, `lane ${laneId} is not in the evidence registry`);
  need(head.sha === sha, `checked out ${head.sha}, the push is ${sha}`);
  need(history === null || (lane.externalInputs ?? []).length === 0,
    `lane ${laneId} reads external inputs; a historical source proof is not specified for it`);
  // 2-4. Where the proof can come from: the merged same-repository pull request
  //      whose merge produced this commit, OR — when no pull request did — the
  //      frozen release-metadata candidate main just fast-forwarded to. Never
  //      both: a commit with both kinds of source is ambiguous and runs in full.
  const pulls = await listArray(api, `repos/${repository}/commits/${sha}/pulls`, LIMITS.pulls);
  const candidates = pulls.filter((p) => isObject(p) && p.merged_at && p.merge_commit_sha === sha
    && p.base?.ref === "main" && p.base?.repo?.id === repositoryId);
  const onMain = await listCounted(api, `repos/${repository}/actions/workflows/${registry.producer.workflow}/runs?head_sha=${sha}`,
    "workflow_runs", LIMITS.runs);
  const src = candidates.length > 0
    ? await pullRequestSource({ api, repository, repositoryId, registry, sha, head, candidates, onMain, lane })
    : await dispatchSource({ api, repository, repositoryId, registry, sha, head, event, pulls, onMain, lane, readFile, loadScope, git });
  const { run, runs, runsPath, latest, attempt } = src;
  const prHead = src.runHead;

  // 5. Freshness: at the machine clock, or — historically — at the instant the
  //    witness was verified, AFTER the witness's source is confirmed (step 7).
  const runAge = (at, absent) => {
    const ageMs = at - Date.parse(run.updated_at);
    const what = `merge-gate run ${run.id} finished ${Math.round(ageMs / 60000)} minutes ${history ? "before the witness" : "ago"}, `
      + `outside ${registry.maxAgeHours}h`;
    need(ageMs >= -LIMITS.clockSkewMs, what);
    absent(ageMs <= registry.maxAgeHours * 3600 * 1000, what);
  };
  if (history === null) runAge(now().getTime(), needAvailable);

  // 6. Every job of the latest attempt, and this lane's obligation in it.
  const jobs = await attemptJobs(api, repository, run.id, attempt, `merge-gate run ${run.id}`);
  const byName = new Map(jobs.map((j) => [j.name, j]));
  for (const job of jobs) {
    need(job.status === "completed", `job ${JSON.stringify(job.name)} of the source run is ${job.status}`);
  }
  for (const name of [registry.producer.aggregateJob, registry.producer.selectJob]) {
    need(byName.get(name)?.conclusion === "success", `the source run's ${name} job did not succeed`);
  }
  const prefix = `${laneId} / `;
  const allChecks = new Set(Object.values(lane.jobs).flatMap((j) => j.checks));
  for (const job of jobs) {
    if (!job.name.startsWith(prefix)) continue;
    const rest = job.name.slice(prefix.length);
    // The generated auxiliaries: the evidence job (decides nothing on a pull
    // request) and the screen and certify jobs, which are skipped everywhere but
    // a main push — one that RAN in the source run is not the source run this
    // file understands.
    if (rest === "evidence") continue;
    if (rest === "screen" || rest === "certify-macos" || rest === "certify-windows") {
      need(job.conclusion === "skipped", `the source run's ${JSON.stringify(job.name)} ${job.conclusion} instead of being skipped`);
      continue;
    }
    need(allChecks.has(rest), `the source run has ${JSON.stringify(job.name)}, which the evidence registry does not know`);
  }
  const required = requiredJobs(lane, scopeValue);
  // The source run's event, as `sourceRun` re-read it by id and as its kind
  // demands: a pull-request proof is a `pull_request` run, both dispatch kinds
  // a `workflow_dispatch` run. Both must agree, or no runner is expected at all.
  const sourceEvent = src.kind === MANIFEST_KIND ? "pull_request" : "workflow_dispatch";
  need(run.event === sourceEvent, `the source run is a ${run.event} run, its ${src.kind} source must be a ${sourceEvent} run`);
  for (const [jobId, checks] of Object.entries(required)) {
    for (const check of checks) {
      const job = byName.get(`${prefix}${check}`);
      need(job !== undefined, `the source run has no ${JSON.stringify(prefix + check)}`);
      need(job.conclusion === "success", `${JSON.stringify(prefix + check)} concluded ${job.conclusion} in the source run`);
      const runner = expectedRunner(lane.jobs[jobId], run.event);
      need(job.labels.length === 1 && job.labels[0] === runner,
        `${JSON.stringify(prefix + check)} ran on [${job.labels.join(", ")}], want [${runner}]`);
    }
  }

  // 7. The proof: one immutable artifact, by id and API digest.
  const { art, zip } = await runArtifact(api, repository, run, prHead, repositoryId,
    `${registry.producer.artifactPrefix}${attempt}`, now);
  let manifest;
  try {
    manifest = JSON.parse(readSingleEntryZip(zip, registry.producer.entry).toString("utf8"));
  } catch (err) {
    if (err instanceof NoReuse) throw err;
    fail(`the proof is not JSON: ${err.message}`);
  }
  validateManifest(manifest);
  if (history !== null) {
    const ws = history.witness.source;
    need(ws.kind === src.kind && ws.pull_request === (src.prNumber ?? null) && ws.head_sha === prHead
      && ws.merge_sha === src.testedSha && ws.run_id === run.id && ws.run_attempt === attempt
      && ws.artifact_id === art.id && ws.artifact_digest === art.digest && ws.produced_at === manifest.produced_at,
    `the witness names source run ${ws.run_id}/${ws.run_attempt} proof ${ws.artifact_id}; this judgement selects `
      + `${run.id}/${attempt} proof ${art.id}`);
    runAge(history.eligibleAt, need);
  }

  // 8. The proof agrees with everything derived independently above.
  const m = manifest;
  need(m.repository.id === repositoryId && m.repository.full_name === repository, "the proof is for another repository");
  need(m.kind === src.kind, `the proof is a ${m.kind}, this commit's source is a ${src.kind}`);
  if (src.kind === MANIFEST_KIND) {
    need(m.pull_request.number === src.prNumber && m.pull_request.head_sha === prHead
      && m.pull_request.head_repository_id === repositoryId && m.pull_request.base_ref === "main",
    "the proof names another pull request or head");
  } else if (src.kind === INTERNAL_KIND) {
    need(m.dispatch.head_sha === sha && m.dispatch.base_sha === src.base && m.dispatch.ref === src.testedRef,
      "the proof names another candidate, base or branch");
    need(JSON.stringify(m.dispatch.paths) === JSON.stringify(src.scope.paths) && m.dispatch.closure_sha256 === src.scope.closure_sha256,
      "the proof's change set or trust closure disagrees with this commit's own judgement");
  } else {
    need(m.dispatch.head_sha === sha && m.dispatch.base_sha === src.base && m.dispatch.ref === src.testedRef,
      "the proof names another candidate, base or branch");
    need(m.dispatch.version === src.scope.version && JSON.stringify(m.dispatch.paths) === JSON.stringify(src.scope.paths)
      && m.dispatch.scope_sha256 === src.scope.scope_sha256,
    "the proof's candidate scope (version, change set or whitelist) disagrees with this commit's own judgement");
  }
  need(m.run.id === run.id && m.run.attempt === attempt, `the proof is from run ${m.run.id} attempt ${m.run.attempt}, not ${run.id}/${attempt}`);
  need(m.run.workflow_sha === src.testedSha, "the proof's gate workflow is not from the tested commit");
  need(m.checkout.sha === src.testedSha && m.checkout.ref === src.testedRef, "the proof's checkout is not the referenced merge ref");
  need(m.checkout.tree === head.tree && m.checkout.tree === src.testedTree, "the proof's tree is not this commit's tree");
  need(m.checkout.parents.join() === src.testedParents.join(), "the proof's merge parents disagree with git");
  need(JSON.stringify(m.referenced_workflows) === JSON.stringify(src.refs), "the proof's referenced workflows disagree with the run");
  need(m.lanes[laneId]?.selected === true && m.lanes[laneId]?.result === "success", `the proof says lane ${laneId} did not run and pass`);
  const apiJobs = jobs.filter((j) => j.name !== registry.producer.aggregateJob)
    .map((j) => ({ id: j.id, name: j.name, status: j.status, conclusion: j.conclusion, labels: j.labels })).sort((a, b) => a.id - b.id);
  need(JSON.stringify(m.jobs) === JSON.stringify(apiJobs), "the proof's job inventory disagrees with the API's");
  need(m.fingerprints[laneId] === laneFingerprint(git, laneId, lane, workflowsDir, readWorkflow), `the proof's ${laneId} input fingerprint disagrees with this tree`);
  need(m.certification.registry_sha256 === sha256(readFile(REGISTRY_FILE))
    && m.certification.verifier_sha256 === sha256(readFile(VERIFIER_FILE))
    && m.certification.selector_sha256 === sha256(readFile(SELECTOR_FILE))
    && m.certification.toolchain_sha256 === sha256(readFile(TOOLCHAIN_FILE))
    && m.certification.toolchain_registry_sha256 === sha256(readFile(TOOLCHAIN_REGISTRY_FILE)),
  "the proof was certified by a different verifier, registry or selector");
  const produced = Date.parse(m.produced_at);
  const ageAt = history === null ? now().getTime() : history.eligibleAt;
  need(produced <= Date.parse(run.updated_at) + LIMITS.clockSkewMs && ageAt - produced >= -LIMITS.clockSkewMs,
    "the proof's timestamp is outside the run or the freshness window");
  (history === null ? needAvailable : need)(ageAt - produced <= registry.maxAgeHours * 3600 * 1000,
    "the proof's timestamp is outside the run or the freshness window");
  // The tag set the tag-reading job ACTUALLY checked out and tested, recorded
  // by that job itself, must still be the repository's tag set now. A tag
  // created after that job's checkout (even before the proof was produced) is
  // a tag no test of this proof ever saw.
  for (const input of lane.externalInputs ?? []) {
    if (required[input.job] === undefined) continue;
    const tested = await testedTagFingerprint(api, repository, run, prHead, repositoryId, attempt, input, now);
    need(tested === await tagFingerprint(api, repository),
      `the repository's tags differ from the tag set ${laneId} / ${input.job} checked out and tested`);
  }

  return { src, run, runs, runsPath, latest, attempt, prHead, jobs, required, art, manifest };
}

/**
 * Step 10's source half, shared: the source run judged by `judgeSourceProof` is
 * still that attempt and result, and nothing newer appeared on its head.
 */
export async function rereadSourceProof({ api, repository, proof }) {
  const { run, runs, runsPath, latest, attempt, prHead } = proof;
  const again = await api.json(`repos/${repository}/actions/runs/${run.id}`);
  need(again.run_attempt === attempt && again.status === "completed" && again.conclusion === "success"
    && again.updated_at === run.updated_at, `merge-gate run ${run.id} changed while it was being verified`);
  const runsAgain = await listCounted(api, runsPath, "workflow_runs", LIMITS.runs);
  need(runListing(runsAgain) === runListing(runs) && newest(runsAgain)?.id === latest.id,
    `the merge-gate runs on ${prHead} changed while being verified`);
}

/**
 * The witness (see `validateWitness`) when this main push may reuse its pull
 * request's proof for `laneId`; throws `NoReuse` with the reason otherwise.
 */
export async function witness({
  env, api, git, registry, laneId, now, workflowsDir, readFile = readRepoFile, loadScope = importScope, toolchainRegistry,
  currentCertificates, screen = false,
}) {
  const lane = registry.lanes[laneId];
  need(lane !== undefined, `lane ${laneId} is not in the evidence registry`);

  // 1. Only an ordinary push to main. Pull requests, dispatches, called runs
  //    and anything carrying inputs run in full.
  need(env.GITHUB_EVENT_NAME === "push", `event ${env.GITHUB_EVENT_NAME} never reuses; only an ordinary push to main does`);
  need(env.GITHUB_REF === "refs/heads/main", `ref ${env.GITHUB_REF} is not refs/heads/main`);
  const repository = env.GITHUB_REPOSITORY;
  const repositoryId = envInt(env.GITHUB_REPOSITORY_ID);
  const sha = env.GITHUB_SHA;
  const runId = envInt(env.GITHUB_RUN_ID);
  const runAttempt = envInt(env.GITHUB_RUN_ATTEMPT);
  need(/^[^/]+\/[^/]+$/.test(repository ?? "") && isInt(repositoryId) && HEX40.test(sha ?? "")
    && isInt(runId) && isInt(runAttempt), "the runner did not describe this run");
  const workflowRef = `${repository}/.github/workflows/${lane.workflow}@refs/heads/main`;
  need(env.GITHUB_WORKFLOW_REF === workflowRef,
    `this is ${env.GITHUB_WORKFLOW_REF}, not ${workflowRef} — a called or renamed run never reuses`);
  let event;
  try { event = JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, "utf8")); } catch (err) { fail(`the push payload is unreadable: ${err.message}`); }
  need(isObject(event) && event.after === sha && event.ref === "refs/heads/main" && event.created === false
    && event.deleted === false && event.forced === false && event.repository?.id === repositoryId,
  "the push is not an ordinary fast-forward of main to this commit");

  const head = headFacts(git);
  need(head.sha === sha, `checked out ${head.sha}, the push is ${sha}`);

  const scopeValue = lane.scope ? env[`CI_EVIDENCE_SCOPE_${lane.scope.output.toUpperCase()}`] : undefined;
  const { src, run, runs, runsPath, latest, attempt, prHead, required, art, manifest: m } = await judgeSourceProof({
    api, git, registry, laneId, repository, repositoryId, sha, head, event, now, workflowsDir, readFile, loadScope, scopeValue,
  });

  // 9. The toolchain. Every witnessed check's own job execution recorded the
  //    toolchain it actually ran on; a fresh run now would get the toolchain the
  //    current probe observed. Both must be the same, field by field, or the
  //    lane runs in full. No profile, an uncertifiable job, a missing or
  //    malformed certificate on either side — all mean full.
  //    The SCREEN stops before the comparison: it only proves that every source
  //    certificate exists and is bound to this source, so that a paid current
  //    probe could complete the proof. It approves nothing.
  const certificates = await certifyToolchains({
    api, repository, repositoryId, run, prHead, attempt, sourceRef: `${repository}/.github/workflows/merge-gate.yml@${src.testedRef}`,
    mergeSha: src.testedSha, laneId, lane, required, toolchainRegistry, currentCertificates,
    current: { runId, runAttempt, sha, workflowRef }, now, screen,
  });

  // 10. Re-read: the source run is still that attempt and that result, nothing
  //    newer appeared on the head, and THIS run is still the push it was.
  await rereadSourceProof({ api, repository, proof: { run, runs, runsPath, latest, attempt, prHead } });
  const current = await api.json(`repos/${repository}/actions/runs/${runId}`);
  need(current.id === runId && current.run_attempt === runAttempt && current.head_sha === sha && current.event === "push"
    && current.path === `.github/workflows/${lane.workflow}` && current.head_branch === "main"
    && current.repository?.id === repositoryId, "this run is not the main push it claims to be");
  if (screen) {
    return { eligible: true, lane: laneId, source: { kind: src.kind, run_id: run.id, run_attempt: attempt, merge_sha: src.testedSha } };
  }

  const w = validateWitness({
    schema: WITNESS_SCHEMA,
    lane: laneId,
    verified_at: isoSeconds(now()),
    target: { repository_id: repositoryId, sha, tree: head.tree, run_id: runId, run_attempt: runAttempt, workflow_ref: workflowRef },
    source: {
      kind: src.kind, pull_request: src.prNumber, head_sha: prHead, merge_sha: src.testedSha, run_id: run.id, run_attempt: attempt,
      artifact_id: art.id, artifact_digest: art.digest, produced_at: m.produced_at,
    },
    jobs: Object.fromEntries(Object.entries(required).filter(([jobId]) => lane.jobs[jobId].mode !== "fresh")),
    certificates,
  });
  return w;
}

/** The latest-executed run of a listing, after the checks every source shares. */
function latestOf(runs, headSha, what) {
  needAvailable(runs.length > 0, `no merge-gate run exists on ${what} ${headSha}`);
  for (const r of runs) {
    need(isObject(r) && isInt(r.id) && r.head_sha === headSha && iso(r.created_at) && iso(r.run_started_at)
      && isInt(r.run_attempt), "a merge-gate run in the listing is malformed or for another head");
  }
  need(new Set(runs.map((r) => r.id)).size === runs.length, "the merge-gate run listing repeats a run");
  const pending = runs.filter((r) => r.status !== "completed");
  needAvailable(pending.length === 0, `${pending.length} merge-gate run(s) on ${headSha} are still ${pending[0]?.status}`);
  return newest(runs);
}

/** The source run re-read by id: completed success of `event`, latest attempt, same repository. */
async function sourceRun(api, repository, repositoryId, registry, latest, event, headSha) {
  const run = await api.json(`repos/${repository}/actions/runs/${latest.id}`);
  need(run.id === latest.id && run.event === event && run.status === "completed" && run.conclusion === "success"
    && run.path === `.github/workflows/${registry.producer.workflow}` && run.head_sha === headSha
    && run.repository?.id === repositoryId && run.head_repository?.id === repositoryId && isInt(run.run_attempt)
    && iso(run.updated_at), `merge-gate run ${latest.id} is not a completed same-repository ${event} success`);
  need(run.run_attempt === latest.run_attempt && run.run_started_at === latest.run_started_at,
    `merge-gate run ${run.id} is attempt ${run.run_attempt} started ${run.run_started_at}, the listing said attempt `
    + `${latest.run_attempt} started ${latest.run_started_at}`);
  return run;
}

async function pullRequestSource({ api, repository, repositoryId, registry, sha, head, candidates, onMain, lane }) {
  need(candidates.length === 1, `${candidates.length} merged pull requests produced this commit, want exactly 1`);
  need(onMain.length === 0, `this commit is both a pull request's merge and the head of ${onMain.length} merge-gate run(s); `
    + "two kinds of source is ambiguous");
  const prNumber = candidates[0].number;
  need(isInt(prNumber), "the associated pull request has no number");
  const pr = await api.json(`repos/${repository}/pulls/${prNumber}`);
  need(pr.number === prNumber && pr.merged === true && pr.merge_commit_sha === sha && pr.base?.ref === "main"
    && pr.base?.repo?.id === repositoryId && HEX40.test(pr.head?.sha ?? ""),
  `pull request #${prNumber} is not merged into main as ${sha}`);
  need(pr.head?.repo?.id === repositoryId, `pull request #${prNumber} comes from a fork; its proof is never reused`);
  const prHead = pr.head.sha;
  // The LATEST-executed merge-gate run on that final head decides; anything
  // newer than a success, or any run still going, means not reuse.
  const runsPath = `repos/${repository}/actions/workflows/${registry.producer.workflow}/runs?head_sha=${prHead}`;
  const runs = await listCounted(api, runsPath, "workflow_runs", LIMITS.runs);
  const latest = latestOf(runs, prHead, "the final head");
  need(latest.event === "pull_request", `the latest merge-gate run on ${prHead} is a ${latest.event} run`);
  need(latest.conclusion === "success", `the latest merge-gate run on ${prHead} concluded ${latest.conclusion}`);
  const run = await sourceRun(api, repository, repositoryId, registry, latest, "pull_request", prHead);
  const merge = mergeRefOf(run, repository, prNumber);
  need(merge.refs.some((r) => r.path === `${repository}/.github/workflows/${lane.workflow}@${merge.sha}`),
    `merge-gate run ${run.id} never called ${lane.workflow}`);
  // What it checked out: the real merge commit, its tree, and its parents.
  const mergeCommit = await api.json(`repos/${repository}/git/commits/${merge.sha}`);
  need(mergeCommit.sha === merge.sha && HEX40.test(mergeCommit.tree?.sha ?? "") && Array.isArray(mergeCommit.parents)
    && mergeCommit.parents.length === 2 && mergeCommit.parents[1]?.sha === prHead,
  `the tested commit ${merge.sha} is not a merge of the pull request head`);
  need(mergeCommit.tree.sha === head.tree, `the tested tree ${mergeCommit.tree.sha} is not this commit's tree ${head.tree}`);
  return {
    kind: MANIFEST_KIND, prNumber, runHead: prHead, runsPath, runs, latest, run, attempt: run.run_attempt,
    testedSha: merge.sha, testedRef: merge.ref, refs: merge.refs, testedTree: mergeCommit.tree.sha,
    testedParents: mergeCommit.parents.map((p) => p.sha),
  };
}

async function dispatchSource({ api, repository, repositoryId, registry, sha, head, event, pulls, onMain, lane, readFile, loadScope, git }) {
  need(pulls.length === 0, `${pulls.length} pull request(s) are associated with this commit but none merged it; `
    + "neither kind of source applies");
  // Main fast-forwarded from exactly the candidate's base to exactly the candidate.
  need(head.parents.length === 1 && HEX40.test(event.before ?? "") && head.parents[0] === event.before,
    "main did not fast-forward by exactly one commit onto the commit it was at");
  const runsPath = `repos/${repository}/actions/workflows/${registry.producer.workflow}/runs?head_sha=${sha}`;
  const latest = latestOf(onMain, sha, "this commit");
  need(latest.event === "workflow_dispatch", `the latest merge-gate run on ${sha} is a ${latest.event} run`);
  need(latest.conclusion === "success", `the latest merge-gate run on ${sha} concluded ${latest.conclusion}`);
  if (INTERNAL_REF.test(`refs/heads/${latest.head_branch}`)) {
    return internalSource({ api, repository, repositoryId, registry, sha, head, git, event, onMain, latest, runsPath, lane, readFile, loadScope });
  }
  need(FROZEN_REF.test(`refs/heads/${latest.head_branch}`), `merge-gate run ${latest.id} ran on ${latest.head_branch}, `
    + "not a frozen release-candidate branch (nor this commit's internal-candidate branch)");
  const run = await sourceRun(api, repository, repositoryId, registry, latest, "workflow_dispatch", sha);
  const ref = `refs/heads/${run.head_branch}`;
  need(FROZEN_REF.test(ref), `merge-gate run ${run.id} ran on ${ref}, not a frozen release-candidate branch`);
  const at = referencedAt(run, repository, ref);
  need(at.sha === sha, `merge-gate run ${run.id} checked out ${at.sha}, not this commit`);
  need(at.refs.some((r) => r.path === `${repository}/.github/workflows/${lane.workflow}@${sha}`),
    `merge-gate run ${run.id} never called ${lane.workflow}`);
  const commit = await api.json(`repos/${repository}/git/commits/${sha}`);
  need(commit.sha === sha && commit.tree?.sha === head.tree && Array.isArray(commit.parents) && commit.parents.length === 1
    && commit.parents[0]?.sha === event.before, "the API's view of this commit is not the candidate on its base");
  // The consumer's own judgement of the candidate, by the same BASE-owned rules
  // as the producer's — neither the proof's mode name nor the fact that main now
  // points here is evidence that this commit was a release-metadata candidate.
  const scope = await frozenCandidateScope({ api, repository, base: event.before, candidate: sha, ref, readFile, loadScope });
  return {
    kind: DISPATCH_KIND, prNumber: null, runHead: sha, runsPath, runs: onMain, latest, run, attempt: run.run_attempt,
    testedSha: sha, testedRef: ref, refs: at.refs, testedTree: head.tree, testedParents: [event.before], base: event.before, scope,
  };
}

/**
 * The internal full candidate main just fast-forwarded to. Every merge-gate
 * run on this commit must be on its own `internal-candidate/<sha>` branch — a
 * frozen or pull-request-mode run beside it is a second kind of source — and the
 * consumer re-judges the candidate itself, with the producer's rules.
 */
async function internalSource({ api, repository, repositoryId, registry, sha, head, git, event, onMain, latest, runsPath, lane, readFile, loadScope }) {
  const branch = `internal-candidate/${sha}`;
  const strays = onMain.filter((r) => r.head_branch !== branch);
  need(strays.length === 0, `merge-gate run ${strays[0]?.id} on this commit ran on ${strays[0]?.head_branch}, not ${branch}; `
    + "two kinds of source is ambiguous");
  const run = await sourceRun(api, repository, repositoryId, registry, latest, "workflow_dispatch", sha);
  const ref = `refs/heads/${run.head_branch}`;
  need(ref === `refs/heads/${branch}`, `merge-gate run ${run.id} ran on ${ref}, not refs/heads/${branch}`);
  const at = referencedAt(run, repository, ref);
  need(at.sha === sha, `merge-gate run ${run.id} checked out ${at.sha}, not this commit`);
  need(at.refs.some((r) => r.path === `${repository}/.github/workflows/${lane.workflow}@${sha}`),
    `merge-gate run ${run.id} never called ${lane.workflow}`);
  // headFacts already bound the one parent to `event.before`; the consumer's own
  // judgement of the candidate repeats the producer's against that base.
  const scope = await internalCandidateScope({ api, repository, base: event.before, candidate: sha, ref,
    git, readFile, loadScope });
  return {
    kind: INTERNAL_KIND, prNumber: null, runHead: sha, runsPath, runs: onMain, latest, run, attempt: run.run_attempt,
    testedSha: sha, testedRef: ref, refs: at.refs, testedTree: head.tree, testedParents: [event.before], base: event.before, scope,
  };
}

/** Throws unless every witnessed job's source certificates equal the current ones; returns their digests. */
async function certifyToolchains({
  api, repository, repositoryId, run, prHead, attempt, sourceRef, mergeSha, laneId, lane, required, toolchainRegistry,
  currentCertificates, current, now, screen = false,
}) {
  need(isObject(toolchainRegistry) && isObject(toolchainRegistry.lanes), "no toolchain registry: nothing is certified");
  need(screen || currentCertificates instanceof Map, "no current toolchain certificates were captured on this main push");
  const out = {};
  for (const [jobId, checks] of Object.entries(required)) {
    if (lane.jobs[jobId].mode === "fresh") continue;
    const entry = toolchainRegistry.lanes[laneId]?.jobs?.[jobId];
    need(isObject(entry), `${laneId}/${jobId} has no toolchain profile, so its toolchain is uncertified`);
    need(entry.uncertifiable === undefined, `${laneId}/${jobId} is uncertifiable: ${entry.uncertifiable}`);
    if (screen) {
      await sourceCertificates({ api, repository, repositoryId, run, prHead, attempt, sourceRef, mergeSha, laneId, jobId, entry,
        checks, toolchainRegistry, now });
      continue;
    }
    const cur = currentCertificates.get(entry.profile);
    need(cur !== undefined, `no current ${entry.profile} certificate was captured on this main push`);
    try { validateCertificate(cur, toolchainRegistry); } catch (err) { fail(`the current ${entry.profile} certificate is unusable: ${err.message}`); }
    const cb = cur.binding;
    const age = now().getTime() - Date.parse(cur.audit.captured_at);
    need(cb.role === "current" && cb.profile === entry.profile && cb.repository_id === repositoryId
      && cb.run_id === current.runId && cb.run_attempt === current.runAttempt && cb.sha === current.sha
      && cb.workflow_ref === current.workflowRef && age >= -LIMITS.clockSkewMs && age <= CURRENT_CERT_MAX_AGE_MS,
    `the current ${entry.profile} certificate was not captured by this run and attempt on this commit just now`);
    const digests = [];
    const sources = await sourceCertificates({ api, repository, repositoryId, run, prHead, attempt, sourceRef, mergeSha, laneId,
      jobId, entry, checks, toolchainRegistry, now });
    for (const [index, src] of sources.entries()) {
      const diff = toolchainDifferences(src, cur);
      need(diff.length === 0, `${laneId}/${jobId} entry ${index} ran on a different toolchain than this runner `
        + `family offers now (${entry.profile}: ${diff.slice(0, 6).join(", ")}${diff.length > 6 ? ", …" : ""})`);
      digests.push(src.digest);
    }
    out[jobId] = { profile: entry.profile, current: cur.digest, source: digests };
  }
  return out;
}

/**
 * The source half of `certifyToolchains`, READ-ONLY and for a proof already
 * judged by `judgeSourceProof`: every witnessed job's source certificates
 * re-downloaded by exact name, re-authenticated by API digest, strictly
 * validated and bound to that source run, attempt, commit, workflow and check
 * index. Returns `{ [jobId]: { profile, source: [value digest...], artifacts:
 * [artifactIdentityOf...] } }` — the value digests AND the complete
 * artifact identities they were read from, so a caller can freeze the chain
 * and re-read it (`rereadArtifactIdentities`). It compares nothing with a
 * current certificate and synthesizes none.
 */
export async function reauthenticateSourceCertificates({
  api, repository, repositoryId, proof, laneId, registry, toolchainRegistry, now,
}) {
  need(isObject(toolchainRegistry) && isObject(toolchainRegistry.lanes), "no toolchain registry: nothing is certified");
  const lane = registry.lanes[laneId];
  const { run, prHead, attempt, src, required } = proof;
  const out = {};
  for (const [jobId, checks] of Object.entries(required)) {
    if (lane.jobs[jobId].mode === "fresh") continue;
    const entry = toolchainRegistry.lanes[laneId]?.jobs?.[jobId];
    need(isObject(entry), `${laneId}/${jobId} has no toolchain profile, so its toolchain is uncertified`);
    need(entry.uncertifiable === undefined, `${laneId}/${jobId} is uncertifiable: ${entry.uncertifiable}`);
    const artifacts = [];
    const sources = await sourceCertificates({ api, repository, repositoryId, run, prHead, attempt,
      sourceRef: `${repository}/.github/workflows/merge-gate.yml@${src.testedRef}`, mergeSha: src.testedSha, laneId, jobId, entry,
      checks, toolchainRegistry, now, identities: artifacts });
    out[jobId] = { profile: entry.profile, source: sources.map((c) => c.digest), artifacts };
  }
  return out;
}

/**
 * The complete API identity of an artifact record — everything `runArtifact`
 * authenticated and a replacement would have to forge: id, name, digest,
 * size, creation, expiry and the run, head SHA, repository and head
 * repository it belongs to. Strictly typed; `null` when the record is not one.
 */
export const ARTIFACT_IDENTITY_KEYS = Object.freeze(["id", "name", "digest", "size_in_bytes", "created_at", "expires_at",
  "run_id", "head_sha", "repository_id", "head_repository_id"]);
export function artifactIdentityOf(a) {
  if (!isObject(a) || !isObject(a.workflow_run)) return null;
  const id = {
    id: a.id, name: a.name, digest: a.digest, size_in_bytes: a.size_in_bytes, created_at: a.created_at,
    expires_at: a.expires_at, run_id: a.workflow_run.id, head_sha: a.workflow_run.head_sha,
    repository_id: a.workflow_run.repository_id, head_repository_id: a.workflow_run.head_repository_id,
  };
  return isArtifactIdentity(id) ? id : null;
}
/** One strict artifact identity: exactly `ARTIFACT_IDENTITY_KEYS`, in order, typed. */
export function isArtifactIdentity(v) {
  return isObject(v) && JSON.stringify(Object.keys(v)) === JSON.stringify(ARTIFACT_IDENTITY_KEYS)
    && isInt(v.id) && typeof v.name === "string" && v.name.length > 0 && v.name.length <= 200
    && typeof v.digest === "string" && /^sha256:[0-9a-f]{64}$/.test(v.digest)
    && Number.isSafeInteger(v.size_in_bytes) && v.size_in_bytes > 0 && iso(v.created_at) && iso(v.expires_at)
    && isInt(v.run_id) && hex40(v.head_sha) && isInt(v.repository_id) && isInt(v.head_repository_id);
}

/**
 * READ-ONLY end re-check of artifact identities a caller froze: each name still
 * lists exactly one artifact of `runId`, AND its record by id still reads, with
 * the same COMPLETE identity (`artifactIdentityOf`: id, name, digest, size,
 * creation, expiry, run, head SHA, repository and head repository), unexpired
 * at a FRESH `now()` per artifact. A replaced, re-uploaded, re-attributed or
 * expired artifact refuses, even if its content would carry the same value.
 * (Expiry here is a change, not an absence: the chain was read a moment ago.)
 */
export async function rereadArtifactIdentities({ api, repository, runId, identities, now }) {
  for (const want of identities) {
    need(isArtifactIdentity(want) && want.run_id === runId, `a frozen artifact identity is not one strict record of run ${runId}`);
    const listed = await listCounted(api, `repos/${repository}/actions/runs/${runId}/artifacts?name=${encodeURIComponent(want.name)}`,
      "artifacts", 20);
    const hits = listed.filter((a) => isObject(a) && a.name === want.name);
    const record = hits.length === 1 ? await api.json(`repos/${repository}/actions/artifacts/${want.id}`) : null;
    const same = (a) => isObject(a) && a.expired === false && JSON.stringify(artifactIdentityOf(a)) === JSON.stringify(want);
    need(hits.length === 1 && same(hits[0]) && same(record) && Date.parse(want.expires_at) > now().getTime(),
      `artifact ${want.name} (${want.id}) changed, was replaced, re-attributed or expired while the chain was being verified`);
  }
}

/** Every source certificate of one witnessed job, downloaded and bound to this source run, in check order. */
async function sourceCertificates({
  api, repository, repositoryId, run, prHead, attempt, sourceRef, mergeSha, laneId, jobId, entry, checks, toolchainRegistry, now,
  identities = null,
}) {
  const out = [];
  for (let index = 0; index < checks.length; index += 1) {
    const name = `${TOOLCHAIN_ARTIFACT_PREFIX}${laneId}-${jobId}-${index}-attempt-${attempt}`;
    const { art, zip } = await runArtifact(api, repository, run, prHead, repositoryId, name, now);
    if (identities !== null) {
      const identity = artifactIdentityOf(art);
      need(identity !== null, `${name} has no complete artifact identity`);
      identities.push(identity);
    }
    let src;
    try {
      src = validateCertificate(JSON.parse(readSingleEntryZip(zip, TOOLCHAIN_ENTRY).toString("utf8")), toolchainRegistry);
    } catch (err) {
      if (err instanceof NoReuse) throw err;
      fail(`${name} is not a usable certificate: ${err instanceof ToolchainUnknown ? err.message : `not JSON (${err.message})`}`);
    }
    const b = src.binding;
    need(b.role === "source" && b.profile === entry.profile && b.lane === laneId && b.job === jobId
      && b.github_job === jobId && b.repository_id === repositoryId && b.run_id === run.id && b.run_attempt === attempt
      && b.sha === mergeSha && b.workflow_ref === sourceRef
      && b.job_index === index && b.job_total === checks.length,
    `${name} is not ${laneId}/${jobId} entry ${index} of ${checks.length} from merge-gate run ${run.id} attempt ${attempt}`);
    out.push(src);
  }
  return out;
}

/**
 * The current certificates a main push captured: `<profile>.json` files in
 * `dir`. A file that is missing, oversized or malformed is simply absent, and
 * a job that needs it is then refused by `certifyToolchains`.
 */
export function readCurrentCertificates(dir, toolchainRegistry, readDir, readFile) {
  const out = new Map();
  if (typeof dir !== "string" || dir === "") return out;
  let names = [];
  try { names = readDir(dir); } catch { return out; }
  for (const name of names) {
    const m = /^([a-z0-9-]+)\.json$/.exec(name);
    if (!m || toolchainRegistry.profiles[m[1]] === undefined) continue;
    try {
      const text = readFile(resolve(dir, name));
      if (text.length > 64 * 1024) continue;
      const cert = validateCertificate(JSON.parse(text), toolchainRegistry);
      if (cert.binding.profile === m[1]) out.set(m[1], cert);
    } catch { /* absent */ }
  }
  return out;
}

// ── confirm ─────────────────────────────────────────────────────────────────

/**
 * Throws unless `witnessText` is a witness for exactly this lane, this main
 * commit, this run and this job id. Offline: the evidence job of this same run
 * did the API work.
 */
export function confirm({ env, laneId, witnessText, registry }) {
  let w;
  try { w = JSON.parse(witnessText ?? ""); } catch { throw new Error("the witness is not JSON"); }
  try { validateWitness(w); } catch (err) { throw new Error(err.message); }
  const lane = registry.lanes[laneId];
  const job = env.GITHUB_JOB;
  const problems = [];
  if (!lane) problems.push(`lane ${laneId} is not in the registry`);
  if (w.lane !== laneId) problems.push(`the witness is for lane ${w.lane}, this is ${laneId}`);
  if (env.GITHUB_EVENT_NAME !== "push" || env.GITHUB_REF !== "refs/heads/main") problems.push("this is not a push to main");
  if (w.target.sha !== env.GITHUB_SHA) problems.push(`the witness is for ${w.target.sha}, this run is ${env.GITHUB_SHA}`);
  if (w.target.run_id !== envInt(env.GITHUB_RUN_ID)) problems.push(`the witness is from run ${w.target.run_id}, this is ${env.GITHUB_RUN_ID}`);
  // The exact attempt, too: "re-run failed jobs" keeps the evidence job's
  // outputs from the earlier attempt, and a witness is a decision made for one
  // attempt. A later attempt re-runs the evidence job or runs in full.
  if (w.target.run_attempt !== envInt(env.GITHUB_RUN_ATTEMPT)) {
    problems.push(`the witness was decided for attempt ${w.target.run_attempt}, this is attempt ${JSON.stringify(env.GITHUB_RUN_ATTEMPT ?? null)}`);
  }
  if (w.target.repository_id !== envInt(env.GITHUB_REPOSITORY_ID)) problems.push("the witness is for another repository");
  if (lane && w.target.workflow_ref !== `${env.GITHUB_REPOSITORY}/.github/workflows/${lane.workflow}@refs/heads/main`) {
    problems.push(`the witness is for ${w.target.workflow_ref}`);
  }
  if (env.GITHUB_WORKFLOW_REF !== w.target.workflow_ref) problems.push(`this run is ${env.GITHUB_WORKFLOW_REF}`);
  if (lane && (lane.jobs[job] === undefined || lane.jobs[job].mode === "fresh")) problems.push(`job ${job} may not be witnessed`);
  else if (lane && JSON.stringify(w.jobs[job]) !== JSON.stringify(lane.jobs[job].checks)) {
    problems.push(`the witness does not vouch for every check of job ${job}`);
  }
  if (problems.length > 0) throw new Error(problems.join("; "));
  return w;
}

// ── the command ─────────────────────────────────────────────────────────────

const log = (message) => process.stderr.write(`ci-evidence: ${message}\n`);

function summary(env, lines) {
  if (!env.GITHUB_STEP_SUMMARY) return;
  try { appendFileSync(env.GITHUB_STEP_SUMMARY, `${lines.join("\n")}\n`); } catch { /* the log already has it */ }
}

function contextFromEnv(env) {
  return {
    env,
    git: (args) => realGit(args),
    now: () => new Date(),
    workflowsDir: resolve(repoRoot, ".github/workflows"),
  };
}

async function runWitness(laneId, env, out, deps) {
  let registry;
  try {
    registry = loadRegistry(readRepoFile(REGISTRY_FILE).toString("utf8"));
    const api = deps.api ?? gitHubApi({ token: env.GH_TOKEN, baseUrl: env.GITHUB_API_URL || undefined });
    let toolchainRegistry = deps.toolchainRegistry;
    if (toolchainRegistry === undefined) {
      try {
        toolchainRegistry = loadToolchainRegistry(readRepoFile(TOOLCHAIN_REGISTRY_FILE).toString("utf8"));
      } catch (err) { fail(`the toolchain registry is unusable: ${err.message}`); }
    }
    const currentCertificates = deps.currentCertificates ?? readCurrentCertificates(env.CI_EVIDENCE_CURRENT_TOOLCHAIN_DIR,
      toolchainRegistry, (d) => readdirSync(d), (f) => readFileSync(f, "utf8"));
    const w = await witness({ ...deps, env, api, registry, laneId, toolchainRegistry, currentCertificates });
    const text = JSON.stringify(w);
    out.write(`reuse=true\nreason=verified\nwitness=${text}\n`);
    log(`REUSE ${laneId}: main ${w.target.sha} (tree ${w.target.tree}) reuses PR #${w.source.pull_request} `
      + `merge-gate run ${w.source.run_id} attempt ${w.source.run_attempt}, merge ${w.source.merge_sha}, `
      + `artifact ${w.source.artifact_id} ${w.source.artifact_digest}; jobs ${Object.keys(w.jobs).join(", ")}`);
    if (env.CI_EVIDENCE_WITNESS_FILE) {
      mkdirSync(dirname(env.CI_EVIDENCE_WITNESS_FILE), { recursive: true });
      writeFileSync(env.CI_EVIDENCE_WITNESS_FILE, `${JSON.stringify(w, null, 2)}\n`);
    }
    summary(env, [`### ${laneId}: reusing pull request #${w.source.pull_request}'s full proof`, "",
      `- target: \`${w.target.sha}\` tree \`${w.target.tree}\``,
      `- source: merge-gate run ${w.source.run_id} attempt ${w.source.run_attempt}, merge \`${w.source.merge_sha}\``,
      `- proof artifact ${w.source.artifact_id} \`${w.source.artifact_digest}\``,
      `- witnessed jobs: ${Object.keys(w.jobs).join(", ")}`]);
  } catch (err) {
    const reason = oneLine(err instanceof NoReuse ? err.message : `unexpected: ${err?.stack ?? err}`);
    out.write(`reuse=false\nreason=${reason}\n`);
    log(`FULL ${laneId}: ${reason}`);
    summary(env, [`### ${laneId}: running in full`, "", `- ${reason}`]);
  }
}

/**
 * The screen: `eligible=true` only when everything but the current-toolchain
 * comparison already holds. Always exits 0; any doubt is `eligible=false`.
 */
async function runScreen(laneId, env, out, deps) {
  try {
    const registry = loadRegistry(readRepoFile(REGISTRY_FILE).toString("utf8"));
    const api = deps.api ?? gitHubApi({ token: env.GH_TOKEN, baseUrl: env.GITHUB_API_URL || undefined });
    let toolchainRegistry = deps.toolchainRegistry;
    if (toolchainRegistry === undefined) {
      try {
        toolchainRegistry = loadToolchainRegistry(readRepoFile(TOOLCHAIN_REGISTRY_FILE).toString("utf8"));
      } catch (err) { fail(`the toolchain registry is unusable: ${err.message}`); }
    }
    const r = await witness({ ...deps, env, api, registry, laneId, toolchainRegistry, currentCertificates: undefined, screen: true });
    need(r?.eligible === true, "the screen returned no verdict");
    out.write("eligible=true\nreason=a source proof awaits a current toolchain certificate\n");
    log(`ELIGIBLE ${laneId}: merge-gate run ${r.source.run_id} attempt ${r.source.run_attempt} (${r.source.kind}); `
      + "the certify jobs may probe — the evidence job still decides");
  } catch (err) {
    const reason = oneLine(err instanceof NoReuse ? err.message : `unexpected: ${err?.stack ?? err}`);
    out.write(`eligible=false\nreason=${reason}\n`);
    log(`NOT ELIGIBLE ${laneId} (no paid probe; the lane runs in full): ${reason}`);
  }
}

/**
 * The handover: the evidence job's LAST step, run only after the witness was
 * kept (`steps.keep.outcome == 'success'`). It re-reads the witness file the
 * upload just retained and prints `reuse=true` + the witness ONLY when that file
 * is a valid witness identical to the one `witness` decided; anything else —
 * missing, unreadable, malformed, different — is `reuse=false`. The evidence
 * job's outputs come from this step alone, so a decision whose witness was not
 * retained (failed or timed-out upload, a job killed in between) never reaches
 * a lane job: empty or false means the full lane. Always exits 0.
 */
export function handover(env, out) {
  try {
    let decided;
    let kept;
    try { decided = JSON.parse(env.CI_EVIDENCE_WITNESS ?? ""); } catch { fail("the decided witness is not JSON"); }
    try { kept = JSON.parse(readFileSync(env.CI_EVIDENCE_WITNESS_FILE ?? "", "utf8")); } catch (err) {
      fail(`the retained witness is unreadable: ${err.code ?? err.message}`);
    }
    try { validateWitness(decided); validateWitness(kept); } catch (err) { fail(`a witness is malformed: ${err.message}`); }
    need(JSON.stringify(decided) === JSON.stringify(kept), "the retained witness is not the decided one");
    out.write(`reuse=true\nwitness=${JSON.stringify(decided)}\n`);
  } catch (err) {
    const reason = oneLine(err instanceof NoReuse ? err.message : `unexpected: ${err?.stack ?? err}`);
    out.write(`reuse=false\nreason=${reason}\n`);
    log(`FULL (handover): ${reason}`);
  }
}

async function runProduce(env, deps) {
  const target = env.CI_EVIDENCE_OUT;
  try {
    need(typeof target === "string" && target.length > 0, "CI_EVIDENCE_OUT is not set");
    const registry = loadRegistry(readRepoFile(REGISTRY_FILE).toString("utf8"));
    const api = deps.api ?? gitHubApi({ token: env.GH_TOKEN, baseUrl: env.GITHUB_API_URL || undefined });
    const manifest = await produce({ ...deps, env, api, registry });
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, `${JSON.stringify(manifest, null, 2)}\n`);
    const what = manifest.pull_request ? `PR #${manifest.pull_request.number}`
      : `${manifest.kind === INTERNAL_KIND ? "internal full" : "frozen"} candidate ${manifest.dispatch.ref}`;
    log(`produced proof for ${what} commit ${manifest.checkout.sha} `
      + `tree ${manifest.checkout.tree}, run ${manifest.run.id} attempt ${manifest.run.attempt}, `
      + `lanes ${Object.keys(manifest.fingerprints).join(", ")}`);
  } catch (err) {
    log(`no proof produced (main will run in full): ${oneLine(err instanceof NoReuse ? err.message : err?.stack ?? err)}`);
  }
}

export async function main(argv, env = process.env, out = process.stdout, deps = contextFromEnv(env)) {
  const [command, laneId, ...rest] = argv;
  if (command === "produce" && laneId === undefined) { await runProduce(env, deps); return 0; }
  if (command === "witness" && typeof laneId === "string" && rest.length === 0) {
    await runWitness(laneId, env, out, deps);
    return 0;
  }
  if (command === "handover" && laneId === undefined) { handover(env, out); return 0; }
  if (command === "screen" && typeof laneId === "string" && rest.length === 0) {
    await runScreen(laneId, env, out, deps);
    return 0;
  }
  if (command === "confirm" && typeof laneId === "string" && rest.length === 0) {
    try {
      const registry = loadRegistry(readRepoFile(REGISTRY_FILE).toString("utf8"));
      const w = confirm({ env, laneId, witnessText: env.CI_EVIDENCE_WITNESS, registry });
      log(`witnessed ${laneId}/${env.GITHUB_JOB} on ${w.target.sha}: checks ${w.jobs[env.GITHUB_JOB].join(" | ")} `
        + `succeeded in merge-gate run ${w.source.run_id} attempt ${w.source.run_attempt} (PR #${w.source.pull_request}, `
        + `merge ${w.source.merge_sha}, artifact ${w.source.artifact_id})`);
      summary(env, [`### ${laneId}/${env.GITHUB_JOB}: witnessed`, "",
        `- proven by merge-gate run ${w.source.run_id} attempt ${w.source.run_attempt} of PR #${w.source.pull_request}`,
        `- checks: ${w.jobs[env.GITHUB_JOB].join(", ")}`]);
      return 0;
    } catch (err) {
      process.stderr.write(`::error::ci-evidence: this job cannot be witnessed: ${oneLine(err.message)}\n`);
      return 1;
    }
  }
  if (command === "internal-candidate" && laneId === "--output" && rest.length === 1) {
    // merge-gate's internal-full-candidate select step: BASE's copy of this file,
    // judging the candidate checked out in the working directory. Unlike every
    // other command it FAILS on doubt — the select job, and so the gate, with it.
    try {
      const cwd = process.cwd();
      const scope = await judgeInternalCandidate({
        env, api: deps.api ?? gitHubApi({ token: env.GH_TOKEN, baseUrl: env.GITHUB_API_URL || undefined }),
        git: deps.candidateGit ?? ((args) => realGit(args, cwd)),
        readFile: deps.candidateReadFile ?? ((path) => readFileSync(resolve(cwd, path))),
        ...(deps.loadScope ? { loadScope: deps.loadScope } : {}),
      });
      writeFileSync(rest[0], `status=${INTERNAL_MODE}\npayload=\nchanged_files=${scope.paths.length}\n`);
      log(`internal full candidate ${env.EXPECTED_HEAD} on ${env.EXPECTED_BASE}: ${scope.paths.length} changed path(s), `
        + `${scope.closure.length} trust input(s) unchanged (closure ${scope.closure_sha256}); every lane will run`);
      return 0;
    } catch (err) {
      process.stderr.write(`::error::ci-evidence: not an internal full candidate: ${oneLine(err instanceof NoReuse ? err.message : err?.stack ?? err)}\n`);
      return 1;
    }
  }
  log("usage: ci-evidence.mjs produce | witness LANE | screen LANE | handover | confirm LANE | internal-candidate --output FILE");
  return 2;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  process.exitCode = await main(process.argv.slice(2));
}
