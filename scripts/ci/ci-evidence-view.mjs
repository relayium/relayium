#!/usr/bin/env node
// scripts/ci/ci-evidence-view.mjs — the PR→main evidence ADOPTION of a lane
// workflow, as a pure, exactly invertible text transformation.
//
// ## Why a transformation, and why it must invert
//
// Evidence reuse (scripts/ci/ci-evidence.mjs) adds the same things to every
// adopted lane: an `evidence` job (with copies of the lane's Ubuntu setup steps
// and the current toolchain probe), a `certify-macos`/`certify-windows` job per
// native family (copies of the lane's own selection/setup steps, then the
// probe) behind a cheap Ubuntu `screen` job that can only ENABLE those paid
// probes, three witness steps at the head of each reusable job, a source
// toolchain capture at the end of each certified job, a `reuse != 'true'` guard
// on every original step, an explicit `!cancelled()` job condition that keeps
// each original job's own `needs`/`if` semantics but never depends on how the
// evidence job ended, and — for a macOS or Windows job — a runner that is
// Ubuntu only on the witness path. Plus the evidence inputs in `push.paths`.
// Written by hand fourteen times, that is fourteen chances to get one guard wrong.
//
// So the adoption is generated, and generated from the lane's FULL-PATH text:
// the workflow exactly as it was before adoption, which is also exactly what
// runs whenever the decision is false, empty or unknown. `fullPathText` removes
// precisely what `adopt` adds and nothing else, so
//
//     adopt(fullPathText(file)) === file
//
// is the canonical-shape check (scripts/test/ci-event-policy-test.mjs, 6x), and
// `fullPathText(file)` is what every guard written about the ORIGINAL steps —
// the iOS lane's independence, the compat gate's "cannot skip itself", the
// contract lanes' shapes — should read. Anything not in canonical form is left
// in place, so such a guard still sees it and still fails.
//
// ## Commands
//
//     ci-evidence-view.mjs adopt   re-derive every registered lane workflow
//                                  from its full-path text (idempotent). After
//                                  any edit to a lane's jobs or steps, edit the
//                                  full path and run this.
//     ci-evidence-view.mjs check   exit 1 when any lane is not exactly
//                                  adopt(fullPathText(file)).
//
// Dependency-free. Nothing here runs in CI's decision path; the verifier does
// not import it.

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

/**
 * Files that decide whether a lane may be witnessed: the verifier, its
 * registry, the filter reader it imports, the adoption transform the policy
 * judges the lanes with, the verifier's own test suite, and the toolchain
 * certificate probe, its registry and its test suite. Each is a merge-gate
 * control file and is in every adopted lane's `push.paths`.
 */
export const EVIDENCE_INPUTS = [
  "scripts/ci/ci-evidence.mjs",
  "scripts/ci/ci-evidence-registry.json",
  "scripts/ci/select-lanes.mjs",
  "scripts/ci/ci-evidence-view.mjs",
  "scripts/test/ci-evidence-test.mjs",
  "scripts/ci/ci-evidence-toolchain.mjs",
  "scripts/ci/ci-evidence-toolchain-registry.json",
  "scripts/test/ci-evidence-toolchain-test.mjs",
];
export const FULL = "needs.evidence.outputs.reuse != 'true'";
export const WITNESS = "needs.evidence.outputs.reuse == 'true'";
export const MAIN_PUSH = "github.event_name == 'push' && github.ref == 'refs/heads/main'";
export const CHECKOUT = "actions/checkout@de0fac2e4500dabe0009e67214ff5f5447ce83dd # v6.0.2";
export const NODE = "actions/setup-node@48b55a011bda9f5d6aeb4c2d9c7362e8dae4041e # v6.4.0";
export const UPLOAD = "actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a # v7.0.1";

export class AdoptError extends Error {}

const indentOf = (line) => line.length - line.trimStart().length;

/** The witness steps, as the lines `adopt` inserts directly after a job's `steps:`. */
export function witnessStepLines(laneId, workingDirectoryDefault) {
  return [
    "      # Witness path (main push whose pull request proof was verified by the",
    "      # `evidence` job): bind this job's check run to that proof, then run",
    "      # nothing else that is not marked fresh in scripts/ci/ci-evidence-registry.json.",
    "      # Every original step below is guarded by `reuse != 'true'`, so an empty,",
    "      # false or unknown decision runs exactly the original job.",
    "      - name: Check out the verifier (witness path only)",
    `        if: ${WITNESS}`,
    `        uses: ${CHECKOUT}`,
    "        with:",
    "          persist-credentials: false",
    "      - name: Node for the verifier (witness path only)",
    `        if: ${WITNESS}`,
    `        uses: ${NODE}`,
    "        with:",
    "          node-version: 24",
    "      - name: Witness — the pull request's full proof covers this job",
    `        if: ${WITNESS}`,
    ...(workingDirectoryDefault ? ["        working-directory: ."] : []),
    "        shell: bash",
    "        env:",
    "          CI_EVIDENCE_WITNESS: ${{ needs.evidence.outputs.witness }}",
    `        run: node scripts/ci/ci-evidence.mjs confirm ${laneId}`,
  ];
}

export const PATHS_COMMENT = [
  "      # The PR→main evidence verifier, its registry, the filter reader it imports,",
  "      # the adoption transform, the toolchain certificate probe and registry, and",
  "      # their tests decide whether a main push may witness this lane instead of",
  "      # re-running it — so a change to any of them is a change to this lane",
  "      # (scripts/ci/ci-evidence-view.mjs).",
];

/**
 * Everything the toolchain certificate adds to one lane, derived from the lane's
 * own full-path text and the toolchain registry:
 *   - the profiles each certified job is captured under,
 *   - the Ubuntu profiles the `evidence` job probes now, after copies of the
 *     lane's own setup steps,
 *   - one `certify-<family>` job per macOS/Windows family, with copies of the
 *     lane's own selection/setup steps.
 */
export const CERTIFY_JOB = { "macos-15": "certify-macos", "windows-latest": "certify-windows" };

function toolchainPlan(lines, laneId, lane, tool) {
  const tl = tool?.lanes?.[laneId];
  if (!tl) throw new AdoptError(`lane ${laneId} has no entry in the toolchain registry`);
  const profiles = {};
  for (const [jobId, job] of Object.entries(lane.jobs)) {
    if (job.mode === "fresh") continue;
    const t = tl.jobs?.[jobId];
    if (!t) throw new AdoptError(`${laneId}/${jobId} has no toolchain entry (a profile or an uncertifiable reason)`);
    if (t.profile) profiles[jobId] = t.profile;
  }
  const byRunner = (runner) => [...new Set(Object.values(profiles).filter((p) => tool.profiles[p].runner === runner))].sort();
  const certify = Object.keys(CERTIFY_JOB).filter((r) => byRunner(r).length > 0).map((runner) => ({
    runner, job: CERTIFY_JOB[runner], profiles: byRunner(runner),
    steps: (tl.certify?.[runner] ?? []).map((ref) => copiedStep(lines, laneId, ref, null)),
  }));
  return {
    profiles,
    ubuntu: byRunner("ubuntu-latest"),
    ubuntuSteps: (tl.ubuntuSetup ?? []).map((ref) => copiedStep(lines, laneId, ref, MAIN_PUSH)),
    certify,
  };
}

/**
 * One step of a lane job, copied for a probe: its own lines, minus `id:` and
 * minus the `cache`/`cache-dependency-path` inputs (which never change what a
 * setup action resolves), with `condition` as its `if:`. A step that carries
 * its own `if:` or relies on a job-level working directory is refused.
 */
function copiedStep(lines, laneId, ref, condition) {
  const { blocks } = jobBlocks(lines);
  const b = blocks.find((x) => x.id === ref.job);
  if (!b) throw new AdoptError(`${laneId}: the toolchain registry copies from ${ref.job}, which the workflow does not declare`);
  const block = lines.slice(b.start, b.end);
  const stepsAt = block.indexOf("    steps:");
  const { items } = splitSteps(block.slice(stepsAt + 1));
  const hits = items.filter((it) => it.lines.length > 0 && stepIdentity(it.lines) === ref.step);
  if (hits.length !== 1) throw new AdoptError(`${laneId}/${ref.job}: ${hits.length} steps are ${JSON.stringify(ref.step)}, want 1`);
  const src = hits[0].lines;
  if (src.some((l, k) => k > 0 && indentOf(l) === 8 && /^if:/.test(l.trim())) || /^- if:/.test(src[0].trim())) {
    throw new AdoptError(`${laneId}/${ref.job}: the step ${JSON.stringify(ref.step)} has its own if:, which a probe cannot copy`);
  }
  const isRun = src.some((l, k) => (k === 0 ? /^- run:/.test(l.trim()) : indentOf(l) === 8 && /^run:/.test(l.trim())));
  const ownWd = src.some((l) => indentOf(l) === 8 && /^working-directory:/.test(l.trim()));
  if (isRun && hasWorkdirDefault(block) && !ownWd) {
    throw new AdoptError(`${laneId}/${ref.job}: the step ${JSON.stringify(ref.step)} runs in the job's default working directory`);
  }
  const out = [];
  let skipping = false;
  for (const [k, line] of src.entries()) {
    if (k > 0 && indentOf(line) === 8 && /^id:/.test(line.trim())) continue;
    if (k > 0 && indentOf(line) === 10 && /^(cache|cache-dependency-path):/.test(line.trim())) { skipping = true; continue; }
    if (skipping && indentOf(line) > 10) continue;
    skipping = false;
    out.push(line);
  }
  if (/^- [A-Za-z-]+:\s*[|>]/.test(out[0].trim())) throw new AdoptError(`${laneId}/${ref.job}: a step opening with a block scalar cannot be copied`);
  if (condition) out.splice(1, 0, `        if: ${condition}`);
  // A `with:` block left empty by removing the cache inputs is removed too.
  for (let k = 0; k < out.length; k += 1) {
    if (out[k] === "        with:" && !(out[k + 1] && indentOf(out[k + 1]) > 8)) { out.splice(k, 1); k -= 1; }
  }
  return out;
}

export const REGION_END = "  # (end of the PR→main evidence jobs; everything above was generated by scripts/ci/ci-evidence-view.mjs)";

export const SCREEN_ELIGIBLE = "needs.screen.result == 'success' && needs.screen.outputs.eligible == 'true'";
export const CERTIFY_CONDITION = `\${{ !cancelled() && ${MAIN_PUSH} && ${SCREEN_ELIGIBLE} }}`;
export const SCREEN_CONDITION = `\${{ !cancelled() && ${MAIN_PUSH} }}`;

/**
 * The availability screen in front of the paid certify jobs: the whole witness
 * check EXCEPT the current-toolchain comparison, on Ubuntu, read-only. It can
 * only ENABLE a certify job; it approves nothing (the evidence job re-derives
 * everything, certificates included). Missing, failed, timed-out or unknown
 * means no `eligible=true`, hence no paid probe, hence the full lane.
 */
function screenJobLines(laneId, scope) {
  return [
    "  # PR→main evidence: a cheap read-only screen before any paid macOS/Windows",
    "  # probe. `eligible=true` only when this main push has a source proof that a",
    "  # current toolchain certificate could complete; it ENABLES the certify jobs",
    "  # and approves nothing. Never red, and anything but `eligible=true` means no",
    "  # paid probe and the full lane.",
    "  screen:",
    ...(scope ? [`    needs: ${scope.job}`] : []),
    `    if: ${SCREEN_CONDITION}`,
    "    runs-on: ubuntu-latest",
    "    timeout-minutes: 5",
    "    continue-on-error: true",
    "    permissions:",
    "      contents: read",
    "      actions: read",
    "      pull-requests: read",
    "    outputs:",
    "      eligible: ${{ steps.screen.outputs.eligible }}",
    "    steps:",
    "      - name: Check out the verifier",
    `        uses: ${CHECKOUT}`,
    "        with:",
    "          persist-credentials: false",
    "      - name: Node for the verifier",
    `        uses: ${NODE}`,
    "        with:",
    "          node-version: 24",
    "      - name: Could a current toolchain certificate complete a proof?",
    "        id: screen",
    "        env:",
    "          GH_TOKEN: ${{ github.token }}",
    ...(scope ? [`          CI_EVIDENCE_SCOPE_${scope.output.toUpperCase()}: \${{ needs.${scope.job}.outputs.${scope.output} }}`] : []),
    `        run: node scripts/ci/ci-evidence.mjs screen ${laneId} >> "$GITHUB_OUTPUT"`,
    "",
  ];
}

/** The certify job for one macOS/Windows family. */
function certifyJobLines(c) {
  return [
    `  # PR→main evidence: the ${c.runner} toolchain a fresh run of this lane would get NOW,`,
    "  # resolved by copies of the lane's own selection/setup steps and certified",
    "  # by scripts/ci/ci-evidence-toolchain.mjs. Ordinary main pushes the screen",
    "  # found eligible only; skipped everywhere else. Bounded at 3 minutes and never",
    "  # red: a failed, slow or unknown probe hands over no certificate, and the",
    "  # lane then runs in full.",
    `  ${c.job}:`,
    "    needs: screen",
    `    if: ${CERTIFY_CONDITION}`,
    `    runs-on: ${c.runner}`,
    "    timeout-minutes: 3",
    "    continue-on-error: true",
    "    outputs:",
    "      certificates: ${{ steps.export.outputs.certificates }}",
    "    steps:",
    "      - name: Check out the probe",
    `        uses: ${CHECKOUT}`,
    "        with:",
    "          persist-credentials: false",
    ...c.steps.flat(),
    "      - name: Certify this runner's toolchain now",
    "        shell: bash",
    `        run: node scripts/ci/ci-evidence-toolchain.mjs current --profiles ${c.profiles.join(",")} --dir "$RUNNER_TEMP/ci-evidence-current"`,
    "      - name: Hand the certificates to the evidence job",
    "        id: export",
    "        shell: bash",
    "        run: node scripts/ci/ci-evidence-toolchain.mjs export --dir \"$RUNNER_TEMP/ci-evidence-current\" >> \"$GITHUB_OUTPUT\"",
    "",
  ];
}

/** The generated region `adopt` inserts directly after `jobs:`: certify jobs, then the evidence job. */
export function evidenceRegionLines(laneId, lane, plan) {
  const scope = lane.scope;
  const screened = plan.certify.length > 0;
  const needs = [...(scope ? [scope.job] : []), ...(screened ? ["screen"] : []), ...plan.certify.map((c) => c.job)];
  const needsLine = needs.length === 0 ? [] : [needs.length === 1 ? `    needs: ${needs[0]}` : `    needs: [${needs.join(", ")}]`];
  return [
    ...(screened ? screenJobLines(laneId, scope) : []),
    ...plan.certify.flatMap(certifyJobLines),
    "  # PR→main evidence reuse (scripts/ci/ci-evidence.mjs; docs/CI-PLATFORM-BOUNDARY.md).",
    "  #",
    "  # On an ORDINARY push to main, decides whether the merged pull request's",
    "  # latest merge-gate run already proved this exact tree for this lane, on the",
    "  # same toolchain this runner family offers now. Every other event — the merge",
    "  # gate's own pull_request call, a dispatch, a release caller — skips the",
    "  # decision, so `reuse` is empty and every job below runs its original steps",
    "  # on its original runner. The verifier always exits 0 and any doubt is",
    "  # `reuse=false`: a missing, partial, stale, uncertified or mismatched proof",
    "  # means the full lane, never approval. It reads the GitHub API (hence the",
    "  # read-only actions/pull-requests grants) and runs nothing it downloads.",
    "  # Never red (`continue-on-error`), and nothing below depends on how it",
    "  # ended: every original job's condition is an explicit `!cancelled()` over",
    "  # its OWN needs, so a failed setup step, a timeout or a skipped dependency",
    "  # here leaves `reuse` empty and the whole lane runs in full.",
    ...(needs.length ? [
      "  # `!cancelled()`: a failed, timed-out or skipped dependency must not skip",
      "  # this job either. It then decides `reuse=false`.",
    ] : []),
    "  evidence:",
    ...needsLine,
    ...(needs.length ? ["    if: ${{ !cancelled() }}"] : []),
    "    runs-on: ubuntu-latest",
    "    timeout-minutes: 10",
    "    continue-on-error: true",
    "    permissions:",
    "      contents: read",
    "      actions: read",
    "      pull-requests: read",
    "    # Promoted ONLY by the handover, after the witness was kept: a decision",
    "    # whose upload failed or timed out, or whose retained file is missing or",
    "    # not the decided witness, never reaches the jobs below.",
    "    outputs:",
    "      reuse: ${{ steps.handover.outputs.reuse }}",
    "      witness: ${{ steps.handover.outputs.witness }}",
    "    steps:",
    "      - name: Check out the verifier (ordinary main push only)",
    `        if: ${MAIN_PUSH}`,
    `        uses: ${CHECKOUT}`,
    "        with:",
    "          persist-credentials: false",
    "      - name: Node for the verifier (ordinary main push only)",
    `        if: ${MAIN_PUSH}`,
    `        uses: ${NODE}`,
    "        with:",
    "          node-version: 24",
    ...plan.ubuntuSteps.flat(),
    ...(plan.ubuntu.length ? [
      "      - name: Certify this runner's toolchain now (ordinary main push only)",
      `        if: ${MAIN_PUSH}`,
      "        shell: bash",
      `        run: node scripts/ci/ci-evidence-toolchain.mjs current --profiles ${plan.ubuntu.join(",")} --dir "$RUNNER_TEMP/ci-evidence-current"`,
    ] : []),
    ...(plan.certify.length ? [
      "      - name: Take the certify jobs' certificates (ordinary main push only)",
      `        if: ${MAIN_PUSH}`,
      "        shell: bash",
      "        env:",
      ...plan.certify.map((c) => `          CI_EVIDENCE_CERTIFICATES_${c.job.slice("certify-".length).toUpperCase()}: \${{ needs['${c.job}'].outputs.certificates }}`),
      "        run: node scripts/ci/ci-evidence-toolchain.mjs import --dir \"$RUNNER_TEMP/ci-evidence-current\"",
    ] : []),
    "      - name: Does the merged pull request's full proof cover this main tree?",
    "        id: verify",
    `        if: ${MAIN_PUSH}`,
    "        env:",
    "          GH_TOKEN: ${{ github.token }}",
    ...(scope ? [`          CI_EVIDENCE_SCOPE_${scope.output.toUpperCase()}: \${{ needs.${scope.job}.outputs.${scope.output} }}`] : []),
    "          CI_EVIDENCE_CURRENT_TOOLCHAIN_DIR: ${{ runner.temp }}/ci-evidence-current",
    `          CI_EVIDENCE_WITNESS_FILE: \${{ runner.temp }}/ci-evidence-witness/${laneId}.json`,
    `        run: node scripts/ci/ci-evidence.mjs witness ${laneId} >> "$GITHUB_OUTPUT"`,
    "      - name: Keep the witness (reuse only)",
    "        id: keep",
    "        if: steps.verify.outputs.reuse == 'true'",
    `        uses: ${UPLOAD}`,
    "        with:",
    `          name: relayium-ci-evidence-witness-${laneId}-attempt-\${{ github.run_attempt }}`,
    "          path: ${{ runner.temp }}/ci-evidence-witness",
    "          if-no-files-found: error",
    "          retention-days: 30",
    "      - name: Hand the decision to the lane only once its witness is kept",
    "        id: handover",
    "        if: steps.verify.outputs.reuse == 'true' && steps.keep.outcome == 'success'",
    "        env:",
    "          CI_EVIDENCE_WITNESS: ${{ steps.verify.outputs.witness }}",
    `          CI_EVIDENCE_WITNESS_FILE: \${{ runner.temp }}/ci-evidence-witness/${laneId}.json`,
    "        run: node scripts/ci/ci-evidence.mjs handover >> \"$GITHUB_OUTPUT\"",
    REGION_END,
    "",
  ];
}

/**
 * The `evidence` job's own lines, as `adopt` writes them for `laneId` (its leading
 * comment included; the screen and certify jobs before it and the region end
 * marker after it excluded). For a consumer that pins the job's shape — the
 * macOS release lane's `CANONICAL_EVIDENCE_JOB` — rather than the whole region.
 */
export function evidenceJobLines(laneId, lane, tool = registries().tool) {
  const plan = toolchainPlan(readFullPath(lane.workflow).split("\n"), laneId, lane, tool);
  const region = evidenceRegionLines(laneId, lane, plan);
  const start = region.indexOf("  # PR→main evidence reuse (scripts/ci/ci-evidence.mjs; docs/CI-PLATFORM-BOUNDARY.md).");
  return region.slice(start, region.indexOf(REGION_END));
}

/** The source capture appended to a certified job's full path. */
export function captureStepLines(laneId, jobId, profile, workingDirectoryDefault) {
  return [
    "      # PR→main evidence: the toolchain this job actually ran on, captured after",
    "      # every tool it used (scripts/ci/ci-evidence-toolchain.mjs). An unknown",
    "      # toolchain uploads nothing, and a job without a certificate is never",
    "      # witnessed; the tests above are unaffected either way.",
    "      - name: Certify this job's toolchain",
    `        if: ${FULL}`,
    ...(workingDirectoryDefault ? ["        working-directory: ."] : []),
    "        shell: bash",
    "        env:",
    "          CI_EVIDENCE_JOB_INDEX: ${{ strategy.job-index }}",
    "          CI_EVIDENCE_JOB_TOTAL: ${{ strategy.job-total }}",
    "          CI_EVIDENCE_MATRIX: ${{ toJSON(matrix) }}",
    `        run: node scripts/ci/ci-evidence-toolchain.mjs capture --role source --profile ${profile} --lane ${laneId} --job ${jobId} --out "$RUNNER_TEMP/ci-evidence-toolchain/toolchain.json"`,
    "      - name: Keep this job's toolchain certificate",
    `        if: ${FULL}`,
    `        uses: ${UPLOAD}`,
    "        with:",
    `          name: relayium-ci-evidence-toolchain-${laneId}-${jobId}-\${{ strategy.job-index }}-attempt-\${{ github.run_attempt }}`,
    "          path: ${{ runner.temp }}/ci-evidence-toolchain/toolchain.json",
    "          if-no-files-found: ignore",
    "          retention-days: 7",
  ];
}

/** A guard around an original condition, and its exact inverse. */
export function guard(original) {
  if (original === undefined) return FULL;
  if (original === "failure()") return `failure() && ${FULL}`;
  if (original === "always()") return `always() && ${FULL}`;
  const always = /^always\(\) && (.+)$/s.exec(original);
  if (always) return `always() && ${FULL} && (${always[1]})`;
  return `${FULL} && (${original})`;
}

export function unguard(condition) {
  if (condition === FULL) return { original: undefined };
  if (condition === `failure() && ${FULL}`) return { original: "failure()" };
  if (condition === `always() && ${FULL}`) return { original: "always()" };
  let m = /^always\(\) && needs\.evidence\.outputs\.reuse != 'true' && \((.+)\)$/s.exec(condition);
  if (m && !m[1].includes("needs.evidence")) return { original: `always() && ${m[1]}` };
  m = /^needs\.evidence\.outputs\.reuse != 'true' && \((.+)\)$/s.exec(condition);
  // `always() && X` is guarded by the branch above, so an original that itself
  // starts with `always() && ` cannot round-trip through this one.
  if (m && !m[1].includes("needs.evidence") && !/^always\(\) && /.test(m[1])) return { original: m[1] };
  return null;
}

/**
 * The job-level condition of an original job (and of a fresh job downstream of
 * one): `!cancelled()`, then `needs.<n>.result == 'success'` for each of its
 * ORIGINAL needs in order, then its original condition in parentheses.
 *
 * Why: an original job also `needs: evidence`, and GitHub's implicit
 * `success()` would skip it — and every job after it — whenever the evidence
 * job failed, timed out or was skipped (a transient setup-node failure, say).
 * That is "no proof ⇒ skipped", the opposite of "no proof ⇒ full". So the
 * implicit `success()` is replaced by exactly what it meant for the ORIGINAL
 * needs. That is exact because no original job of an adopted lane carries a
 * status function (`adopt` refuses one): a dependency that succeeded therefore
 * ran under its own implicit `success()`, so all of ITS ancestors succeeded
 * too, by induction — the transitive part of `success()` holds as well.
 */
export const STATUS_FUNCTION = /\b(?:always|success|failure|cancelled)\s*\(/;
export function jobCondition(needs, original) {
  const parts = ["!cancelled()", ...needs.map((n) => `needs.${n}.result == 'success'`)];
  if (original !== undefined) parts.push(`(${original})`);
  return `\${{ ${parts.join(" && ")} }}`;
}

/** The original condition (`undefined` for none) of a `jobCondition` for `needs`, or null when it is not one. */
export function unJobCondition(condition, needs) {
  const head = `\${{ ${["!cancelled()", ...needs.map((n) => `needs.${n}.result == 'success'`)].join(" && ")}`;
  if (condition === `${head} }}`) return { original: undefined };
  if (condition.startsWith(`${head} && (`) && condition.endsWith(") }}")) {
    const original = condition.slice(head.length + 5, -4);
    if (original !== "" && !original.includes("${{") && !original.includes("needs.evidence") && !STATUS_FUNCTION.test(original)) {
      return { original };
    }
  }
  return null;
}

const RUNNER_TERNARY = /^ {4}runs-on: \$\{\{ needs\.evidence\.outputs\.reuse == 'true' && 'ubuntu-latest' \|\| '(macos-15|windows-latest)' \}\}$/;

/** The step items under one job's `steps:`, each with its leading comment/blank lines. */
function splitSteps(body) {
  const items = [];
  let cur = { pre: [], lines: [] };
  let trail = [];
  for (const line of body) {
    if (indentOf(line) === 6 && line.trim().startsWith("- ")) {
      if (cur.lines.length) { items.push(cur); cur = { pre: trail, lines: [] }; trail = []; } else { cur.pre.push(...trail); trail = []; }
      cur.lines.push(line);
    } else if (cur.lines.length === 0) {
      cur.pre.push(line);
    } else if (line.trim() === "" || (indentOf(line) <= 6 && line.trim().startsWith("#"))) {
      trail.push(line);
    } else {
      cur.lines.push(...trail);
      trail = [];
      cur.lines.push(line);
    }
  }
  if (cur.lines.length || cur.pre.length) items.push(cur);
  return { items, trail };
}

/** name, else uses (without @…), else a one-line run: the `freshSteps` identity. */
export function stepIdentity(lines) {
  let name; let uses; let run;
  for (const [k, line] of lines.entries()) {
    const at = k === 0 ? 8 : indentOf(line);
    if (at !== 8) continue;
    const m = /^(?:- )?(name|uses|run):\s*(.*)$/.exec(line.trim());
    if (!m) continue;
    if (m[1] === "name" && name === undefined) name = m[2].replace(/^(['"])(.*)\1$/, "$2");
    if (m[1] === "uses" && uses === undefined) uses = m[2].split("@")[0];
    if (m[1] === "run" && run === undefined) run = m[2];
  }
  return name ?? uses ?? run;
}

/** `{ id, start, end }` for every job under `jobs:`, end exclusive, trailing comments excluded. */
function jobBlocks(lines) {
  const jobsAt = lines.indexOf("jobs:");
  if (jobsAt === -1) throw new AdoptError("no top-level `jobs:`");
  const starts = [];
  for (let i = jobsAt + 1; i < lines.length; i += 1) {
    if (lines[i].trim() !== "" && indentOf(lines[i]) === 0) break;
    if (indentOf(lines[i]) === 2 && /^[a-z0-9-]+:\s*$/.test(lines[i].trim())) starts.push(i);
  }
  let stop = lines.length;
  for (let i = jobsAt + 1; i < lines.length; i += 1) {
    if (lines[i].trim() !== "" && indentOf(lines[i]) === 0) { stop = i; break; }
  }
  return {
    jobsAt,
    blocks: starts.map((s, k) => {
      let e = k + 1 < starts.length ? starts[k + 1] : stop;
      while (e - 1 > s && (lines[e - 1].trim() === "" || (indentOf(lines[e - 1]) === 2 && lines[e - 1].trim().startsWith("#")))) e -= 1;
      return { id: lines[s].trim().slice(0, -1), start: s, end: e };
    }),
  };
}

const hasWorkdirDefault = (block) => {
  const at = block.indexOf("    defaults:");
  return at >= 0 && block[at + 1] === "      run:" && /^ {8}working-directory:/.test(block[at + 2] ?? "");
};

/** The `push.paths` list's index range in `lines`, or null when there is none. */
function pushPathsRange(lines) {
  const on = lines.indexOf("on:");
  if (on === -1) return null;
  let inPush = false; let inPaths = false; let first = -1; let last = -1;
  for (let i = on + 1; i < lines.length; i += 1) {
    const l = lines[i];
    if (l.trim() === "") continue;
    const ind = indentOf(l);
    if (ind === 0) break;
    if (l.trim().startsWith("#")) continue;
    if (ind === 2) { inPush = l.trim() === "push:"; inPaths = false; continue; }
    if (inPush && ind === 4) { inPaths = l.trim().startsWith("paths:"); continue; }
    if (inPaths && ind === 6 && l.trim().startsWith("- ")) { if (first < 0) first = i; last = i; }
  }
  return first < 0 ? null : { first, last };
}

/** A job header's original `needs` (a flow list or one name; a block list is refused). */
function headerNeeds(header, laneId, jobId) {
  const at = header.findIndex((l) => indentOf(l) === 4 && /^needs:/.test(l.trim()));
  if (at === -1) return { at, needs: [] };
  const v = header[at].trim().slice("needs:".length).trim();
  if (v === "") throw new AdoptError(`${laneId}/${jobId}: a block \`needs:\` list is not supported`);
  const needs = (v.startsWith("[") ? v.slice(1, -1).split(",") : [v]).map((n) => n.trim());
  if (needs.some((n) => !/^[a-z0-9-]+$/.test(n))) throw new AdoptError(`${laneId}/${jobId}: needs ${v} is not a plain list of job ids`);
  return { at, needs };
}

/**
 * Replaces (or adds, directly after `needs:`) the job-level `if:` with
 * `jobCondition(originalNeeds, original)`. Refuses an original condition it
 * cannot carry exactly: a status function, an expression wrapper, a quoted or
 * multi-line scalar, or one that already reads the evidence decision.
 */
function rewriteJobCondition(header, originalNeeds, laneId, jobId) {
  const ifAt = header.findIndex((l) => indentOf(l) === 4 && /^if:/.test(l.trim()));
  if (ifAt === -1) {
    const needsAt = header.findIndex((l) => indentOf(l) === 4 && /^needs:/.test(l.trim()));
    if (needsAt === -1) throw new AdoptError(`${laneId}/${jobId}: no \`needs:\` to anchor the job condition`);
    header.splice(needsAt + 1, 0, `    if: ${jobCondition(originalNeeds)}`);
    return;
  }
  const original = header[ifAt].trim().slice(3).trim();
  if (original === "" || /^['"|>]/.test(original) || original.includes("${{") || original.includes("needs.evidence")
    || STATUS_FUNCTION.test(original) || (header[ifAt + 1] !== undefined && indentOf(header[ifAt + 1]) > 4)) {
    throw new AdoptError(`${laneId}/${jobId}: the job condition ${JSON.stringify(original)} cannot be carried exactly`);
  }
  header[ifAt] = `    if: ${jobCondition(originalNeeds, original)}`;
}

/** The inverse of `rewriteJobCondition` over a header whose `needs:` is already the original. */
function restoreJobCondition(header) {
  const { at, needs } = (() => { try { return headerNeeds(header, "-", "-"); } catch { return { at: -1, needs: [] }; } })();
  const ifAt = header.findIndex((l) => indentOf(l) === 4 && /^if:/.test(l.trim()));
  if (ifAt === -1) return header;
  const back = unJobCondition(header[ifAt].trim().slice(3).trim(), needs);
  if (back === null) return header;
  const out = [...header];
  if (back.original === undefined) {
    // Only where `rewriteJobCondition` would have put it; anything else stays and fails the round trip.
    if (at >= 0 && ifAt === at + 1) out.splice(ifAt, 1);
  } else {
    out[ifAt] = `    if: ${back.original}`;
  }
  return out;
}

/** Fresh jobs downstream of a witnessable job: their implicit `success()` would also see the evidence job. */
function downstreamFresh(lines, blocks, lane, laneId) {
  const needsOf = new Map(blocks.map((b) => {
    const block = lines.slice(b.start, b.end);
    const stepsAt = block.indexOf("    steps:");
    return [b.id, headerNeeds(stepsAt === -1 ? block : block.slice(0, stepsAt), laneId, b.id).needs];
  }));
  const reaches = (id, seen = new Set()) => (needsOf.get(id) ?? []).some((n) => {
    if (seen.has(n)) return false;
    seen.add(n);
    return (lane.jobs[n] && lane.jobs[n].mode !== "fresh") || reaches(n, seen);
  });
  return new Set(blocks.map((b) => b.id).filter((id) => lane.jobs[id]?.mode === "fresh" && reaches(id)));
}

function adoptJob(block, laneId, jobId, job, profile) {
  const stepsAt = block.indexOf("    steps:");
  if (stepsAt === -1) throw new AdoptError(`${laneId}/${jobId}: no \`steps:\``);
  const header = block.slice(0, stepsAt);
  const originalNeeds = headerNeeds(header, laneId, jobId).needs;
  let sawNeeds = false;
  for (let k = 0; k < header.length; k += 1) {
    const line = header[k];
    if (indentOf(line) !== 4) continue;
    const needs = /^needs:\s*(.*)$/.exec(line.trim());
    if (needs) {
      sawNeeds = true;
      const v = needs[1].trim();
      if (v === "") throw new AdoptError(`${laneId}/${jobId}: a block \`needs:\` list is not supported`);
      if (v.includes("evidence")) throw new AdoptError(`${laneId}/${jobId}: already needs evidence`);
      header[k] = v.startsWith("[") ? `    needs: [${v.slice(1, -1).trim()}, evidence]` : `    needs: [${v}, evidence]`;
    }
    const runsOn = /^runs-on:\s*(.*)$/.exec(line.trim());
    if (runsOn) {
      const v = runsOn[1].trim();
      if (job.runner !== "ubuntu-latest") {
        if (v !== job.runner) throw new AdoptError(`${laneId}/${jobId}: runs-on ${v}, the registry says ${job.runner}`);
        header[k] = `    runs-on: \${{ ${WITNESS} && 'ubuntu-latest' || '${v}' }}`;
      }
    }
  }
  if (!sawNeeds) {
    const at = header.findIndex((l) => indentOf(l) === 4 && /^runs-on:/.test(l.trim()));
    if (at === -1) throw new AdoptError(`${laneId}/${jobId}: no runs-on`);
    header.splice(at, 0, "    needs: evidence");
  }
  rewriteJobCondition(header, originalNeeds, laneId, jobId);
  const out = [...header, block[stepsAt], ...witnessStepLines(laneId, hasWorkdirDefault(block))];
  const { items, trail } = splitSteps(block.slice(stepsAt + 1));
  const fresh = new Set(job.freshSteps ?? []);
  const seen = new Map();
  for (const item of items) {
    out.push(...item.pre);
    if (item.lines.length === 0) continue;
    const id = stepIdentity(item.lines);
    if (fresh.has(id)) {
      seen.set(id, (seen.get(id) ?? 0) + 1);
      out.push(...item.lines);
      continue;
    }
    const lines = [...item.lines];
    const ifAt = lines.findIndex((l, k) => k > 0 && indentOf(l) === 8 && /^if:/.test(l.trim()));
    if (/^- if:/.test(lines[0].trim())) throw new AdoptError(`${laneId}/${jobId}: a step opening with \`- if:\` is not supported`);
    if (ifAt >= 0) {
      const original = lines[ifAt].trim().slice(3).trim();
      if (original.includes("needs.evidence")) throw new AdoptError(`${laneId}/${jobId}: a step already reads the evidence decision`);
      lines[ifAt] = `        if: ${guard(original)}`;
    } else {
      const firstValue = lines[0].trim().slice(2).replace(/^[A-Za-z-]+:\s*/, "");
      if (/^[|>]/.test(firstValue)) lines.push(`        if: ${FULL}`);
      else lines.splice(1, 0, `        if: ${FULL}`);
    }
    out.push(...lines);
  }
  if (profile) out.push(...captureStepLines(laneId, jobId, profile, hasWorkdirDefault(block)));
  out.push(...trail);
  for (const id of fresh) {
    if (seen.get(id) !== 1) throw new AdoptError(`${laneId}/${jobId}: fresh step ${JSON.stringify(id)} matches ${seen.get(id) ?? 0} steps`);
  }
  return out;
}

/**
 * The adopted workflow for one lane, from its full-path text and the toolchain
 * registry. Throws `AdoptError` on any shape it does not model rather than
 * guessing.
 */
export function adopt(text, laneId, lane, tool) {
  const lines = text.split("\n");
  if (lines.some((l) => l.includes("needs.evidence") || /^ {2}(evidence|screen|certify-[a-z]+):\s*$/.test(l) || l === REGION_END)) {
    throw new AdoptError(`${lane.workflow} is already adopted; adopt its full-path text`);
  }
  const { jobsAt, blocks } = jobBlocks(lines);
  const declared = blocks.map((b) => b.id).sort();
  const registered = Object.keys(lane.jobs).sort();
  if (declared.join() !== registered.join()) {
    throw new AdoptError(`${lane.workflow} declares [${declared}], the registry lists [${registered}]`);
  }
  const plan = toolchainPlan(lines, laneId, lane, tool);
  const downstream = downstreamFresh(lines, blocks, lane, laneId);
  const out = [...lines.slice(0, jobsAt + 1), ...evidenceRegionLines(laneId, lane, plan)];
  let cursor = jobsAt + 1;
  for (const b of blocks) {
    out.push(...lines.slice(cursor, b.start));
    const job = lane.jobs[b.id];
    const block = lines.slice(b.start, b.end);
    if (job.mode !== "fresh") {
      out.push(...adoptJob(block, laneId, b.id, job, plan.profiles[b.id]));
    } else if (downstream.has(b.id)) {
      const stepsAt = block.indexOf("    steps:");
      const header = block.slice(0, stepsAt);
      rewriteJobCondition(header, headerNeeds(header, laneId, b.id).needs, laneId, b.id);
      out.push(...header, ...block.slice(stepsAt));
    } else {
      out.push(...block);
    }
    cursor = b.end;
  }
  out.push(...lines.slice(cursor));
  if (!lane.unfiltered) {
    const range = pushPathsRange(out);
    if (!range) throw new AdoptError(`${lane.workflow} has no push.paths`);
    const present = new Set(out.slice(range.first, range.last + 1).map((l) => l.trim().slice(2).replace(/^'(.*)'$/, "$1")));
    if (EVIDENCE_INPUTS.some((p) => present.has(p))) throw new AdoptError(`${lane.workflow} already lists an evidence input`);
    out.splice(range.last + 1, 0, ...PATHS_COMMENT, ...EVIDENCE_INPUTS.map((p) => `      - '${p}'`));
  }
  return out.join("\n");
}

/**
 * The full-path text of an adopted lane workflow: the canonical adoption
 * removed, nothing else. The removal is accepted ONLY when adopting the result
 * reproduces the file byte for byte; any other file — an odd guard, a hand-edited
 * certify job, a missing capture — is returned unchanged, so no guard is ever
 * told an adoption is safe that the generator would not have written.
 */
export function fullPathText(text, laneId, lane, tool) {
  const lines = text.split("\n");
  const jobsAt = lines.indexOf("jobs:");
  const end = lines.indexOf(REGION_END);
  if (jobsAt === -1 || end <= jobsAt || lines[end + 1] !== "") return text;
  let out = [...lines.slice(0, jobsAt + 1), ...lines.slice(end + 2)];
  if (!lane.unfiltered) {
    const range = pushPathsRange(out);
    const block = [...PATHS_COMMENT, ...EVIDENCE_INPUTS.map((p) => `      - '${p}'`)];
    const start = range ? range.last + 1 - block.length : -1;
    if (start >= 0 && out.slice(start, range.last + 1).join("\n") === block.join("\n")) out.splice(start, block.length);
  }
  const toolLane = tool?.lanes?.[laneId];
  const { blocks } = jobBlocks(out);
  for (const b of [...blocks].reverse()) {
    const job = lane.jobs[b.id];
    if (!job) continue;
    if (job.mode === "fresh") {
      const block = out.slice(b.start, b.end);
      const stepsAt = block.indexOf("    steps:");
      if (stepsAt === -1) continue;
      out = [...out.slice(0, b.start), ...restoreJobCondition(block.slice(0, stepsAt)), ...block.slice(stepsAt), ...out.slice(b.end)];
      continue;
    }
    let block = out.slice(b.start, b.end);
    const stepsAt = block.indexOf("    steps:");
    if (stepsAt === -1) continue;
    const workdir = hasWorkdirDefault(block);
    const witness = witnessStepLines(laneId, workdir);
    if (block.slice(stepsAt + 1, stepsAt + 1 + witness.length).join("\n") !== witness.join("\n")) continue;
    const profile = toolLane?.jobs?.[b.id]?.profile;
    if (profile) {
      const cap = captureStepLines(laneId, b.id, profile, workdir).join("\n");
      const joined = block.join("\n");
      const at = joined.lastIndexOf(`\n${cap}`);
      if (at >= 0) block = (joined.slice(0, at) + joined.slice(at + cap.length + 1)).split("\n");
    }
    const fresh = new Set(job.freshSteps ?? []);
    let header = block.slice(0, stepsAt);
    // The condition first, while `needs: evidence` still anchors where an added one sits.
    const anchored = header.indexOf("    needs: evidence");
    if (anchored >= 0 && header[anchored + 1] === `    if: ${jobCondition([])}`) header.splice(anchored + 1, 1);
    header = header.flatMap((line) => {
      if (line === "    needs: evidence") return [];
      const needs = /^ {4}needs: \[(.*), evidence\]$/.exec(line);
      if (needs) return [needs[1].includes(",") ? `    needs: [${needs[1]}]` : `    needs: ${needs[1]}`];
      const runner = RUNNER_TERNARY.exec(line);
      if (runner) return [`    runs-on: ${runner[1]}`];
      return [line];
    });
    header = restoreJobCondition(header);
    const { items, trail } = splitSteps(block.slice(stepsAt + 1 + witness.length));
    const body = [];
    for (const item of items) {
      body.push(...item.pre);
      if (item.lines.length === 0) continue;
      if (fresh.has(stepIdentity(item.lines))) { body.push(...item.lines); continue; }
      for (const [k, line] of item.lines.entries()) {
        if (k > 0 && indentOf(line) === 8 && /^if:/.test(line.trim())) {
          const back = unguard(line.trim().slice(3).trim());
          if (back === null) { body.push(line); continue; }
          if (back.original !== undefined) body.push(`        if: ${back.original}`);
          continue;
        }
        body.push(line);
      }
    }
    body.push(...trail);
    out = [...out.slice(0, b.start), ...header, block[stepsAt], ...body, ...out.slice(b.end)];
  }
  const candidate = out.join("\n");
  try {
    if (adopt(candidate, laneId, lane, tool) === text) return candidate;
  } catch { /* not canonical */ }
  return text;
}

/** The registered lane, if any, for a workflow file name. */
export function laneOfWorkflow(registry, file) {
  for (const [laneId, lane] of Object.entries(registry.lanes ?? {})) if (lane.workflow === file) return { laneId, lane };
  return null;
}

/**
 * The full-path text of workflow `file` (a bare name like `go.yml`) given its
 * raw `text`; a file that is not a registered evidence lane comes back
 * unchanged. This is the one call a guard written about a lane's ORIGINAL jobs
 * and steps needs: `fullPathOf(name, readFileSync(…))` where it reads the file.
 */
export function fullPathOf(file, text, { root = repoRoot } = {}) {
  const { registry, tool } = registries(root);
  const hit = laneOfWorkflow(registry, file.replace(/^.*\//, ""));
  return hit ? fullPathText(text, hit.laneId, hit.lane, tool) : text;
}

/** Both registries, as JSON (the verifier's loaders check them; this only reads). */
export function registries(root = repoRoot) {
  return {
    registry: JSON.parse(readFileSync(resolve(root, "scripts/ci/ci-evidence-registry.json"), "utf8")),
    tool: JSON.parse(readFileSync(resolve(root, "scripts/ci/ci-evidence-toolchain-registry.json"), "utf8")),
  };
}

/** A workflow file's full-path text, read from disk; unregistered files unchanged. */
export function readFullPath(file, { root = repoRoot } = {}) {
  return fullPathOf(file, readFileSync(resolve(root, ".github/workflows", file), "utf8"), { root });
}

function main(argv) {
  const { registry, tool } = registries();
  const [command] = argv;
  if (command !== "adopt" && command !== "check") {
    process.stderr.write("usage: ci-evidence-view.mjs adopt | check\n");
    return 2;
  }
  let bad = 0;
  for (const [laneId, lane] of Object.entries(registry.lanes)) {
    const file = resolve(repoRoot, ".github/workflows", lane.workflow);
    const text = readFileSync(file, "utf8");
    let want;
    try {
      want = adopt(fullPathText(text, laneId, lane, tool), laneId, lane, tool);
    } catch (err) {
      process.stderr.write(`ci-evidence-view: ${lane.workflow}: ${err.message}\n`);
      bad += 1;
      continue;
    }
    if (want === text) continue;
    if (command === "adopt") {
      writeFileSync(file, want);
      process.stdout.write(`adopted ${lane.workflow}\n`);
    } else {
      process.stderr.write(`ci-evidence-view: ${lane.workflow} is not the canonical adoption of its full path\n`);
      bad += 1;
    }
  }
  return bad === 0 ? 0 : 1;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  process.exitCode = main(process.argv.slice(2));
}
