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
//     ui-smoke shards and signed-build — every one completed `success` and
//     EXECUTED (judged from its step records, never witnessed). A skipped UI
//     shard is not a pass. Under a canonical PR→main evidence adoption the
//     run also has exactly the three auxiliary jobs `screen`, `certify-macos`
//     and `evidence` — no other job, ever. That adoption is the current one
//     (`contract` always fresh, its runner chosen by release inputs) or, each
//     whole, one of the two frozen ones before it (`contract` always fresh but
//     its runner chosen by the caller's event too; before that, `contract`
//     witnessed and certified on Ubuntu), never a mix;
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

// F's shared read-only judge is imported only when a run is certified (see
// `judgeCertifiedCoverage`): every executed-route caller, including the frozen
// merge-gate step that runs this file alone from a BASE worktree, never loads it.
const loadF = () => Promise.all([import("../ci/ci-evidence.mjs"), import("../ci/ci-evidence-toolchain.mjs")])
  .then(([f, toolchain]) => ({ ...f, TOOLCHAIN_REGISTRY_FILE: toolchain.TOOLCHAIN_REGISTRY_FILE,
    loadToolchainRegistry: toolchain.loadToolchainRegistry }));

export const PRODUCER_WORKFLOW = ".github/workflows/macos.yml";
export const GATE_WORKFLOW = ".github/workflows/merge-gate.yml";
export const PROVENANCE_SCHEMA = "relayium-macos-signed-provenance/v2";
export const EVIDENCE_SCHEMA = "relayium-macos-reuse-evidence/v2";
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
 * The other two jobs that adoption inserts in front of it, and only then: the
 * read-only availability screen and the paid macOS toolchain probe it may
 * enable. Both are `continue-on-error` and approve nothing; each must still be
 * there exactly once, completed, and never `cancelled`, so no unknown job and
 * no missing one is ever waived. (`skipped` is their normal state when the
 * merged pull request had no usable proof.)
 */
export const SCREEN_JOB = { id: "screen", match: (name) => name === "screen" };
export const CERTIFY_JOB = { id: "certify-macos", match: (name) => name === "certify-macos" };
export const AUXILIARY_JOBS = [SCREEN_JOB, CERTIFY_JOB, EVIDENCE_JOB];
const AUXILIARY_CONCLUSIONS = {
  screen: ["success", "failure", "skipped"],
  "certify-macos": ["success", "failure", "skipped"],
  evidence: ["success"],
};

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
 * they must not appear at all; under an adoption they must be reported
 * skipped (or omitted) — except in the current adoption's `contract`, which
 * has no witness path at all, so there they must not appear either. Each UI
 * shard must not have run the OTHER shard's suite, and the evidence job must
 * not have kept a witness.
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
  // Neither kept a witness nor handed a decision to the lane: the jobs below
  // only ever see `reuse=true` through the handover step.
  evidence: ["Keep the witness (reuse only)", "Hand the decision to the lane only once its witness is kept"],
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
 * non-comment lines of the three inserted jobs, of the three-step witness
 * prefix, and of the `needs`/`if`/`runs-on` lines adoption gives the five
 * original jobs — exactly as `scripts/ci/ci-evidence-view.mjs` writes them for
 * `adopt(fullPathText(macos.yml))`. Comments are ignored so an edit to their
 * prose does not turn reuse off; any structural difference does.
 * `scripts/test/macos-evidence-cases.mjs` compares each of these with that
 * generator (`evidenceJobLines`, `witnessStepLines`, and the jobs of its own
 * adoption of the full-path text) whenever it is present in the tree.
 *
 * The original jobs' conditions are pinned because they are what keeps the
 * lane honest when the auxiliary jobs fail: an explicit `!cancelled()` over
 * each job's OWN needs, so a failed, timed-out or skipped `evidence` leaves
 * `reuse` empty and every gate runs in full on its own runner.
 *
 * The generator, the drift check and these pins know only the CURRENT
 * adoption, in which `contract` is always fresh: its runner follows release
 * inputs (macos-15 only for a non-empty release_version, notarize or
 * publish_release), so it has no witness prefix, no step guards and no
 * toolchain capture, and the evidence job has no Ubuntu probe. Two frozen
 * generations precede it, each judged WHOLE: `adopted-event-contract` (the same
 * fresh contract, but runner and release branch also reading the caller's
 * event: `EVENT_CONTRACT_JOB`) and, before that, `adopted-witnessed-contract`
 * (`WITNESSED_CONTRACT_EVIDENCE_JOB` plus the entire historical
 * `WITNESSED_CONTRACT_JOB`, witness prefix, guards and capture included).
 * Inside the witnessed adoption only,
 * `ui-smoke` may also carry the older triple that still waited for `test`
 * (`LEGACY_ADOPTED_UI_SMOKE_CONDITIONS`), again as a WHOLE triple. No part of
 * one adoption is ever accepted beside a part of the other. These are
 * verifier-only allowances: the CI policy (`scripts/test/ci-event-policy-test.mjs`)
 * still refuses every old shape in the current workflow, and every other check
 * of a reused build is unchanged.
 */
export const CANONICAL_SCREEN_JOB = [
  "  screen:",
  "    if: ${{ !cancelled() && github.event_name == 'push' && github.ref == 'refs/heads/main' }}",
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
  "        uses: actions/checkout@de0fac2e4500dabe0009e67214ff5f5447ce83dd # v6.0.2",
  "        with:",
  "          persist-credentials: false",
  "      - name: Node for the verifier",
  "        uses: actions/setup-node@48b55a011bda9f5d6aeb4c2d9c7362e8dae4041e # v6.4.0",
  "        with:",
  "          node-version: 24",
  "      - name: Could a current toolchain certificate complete a proof?",
  "        id: screen",
  "        env:",
  "          GH_TOKEN: ${{ github.token }}",
  "        run: node scripts/ci/ci-evidence.mjs screen macos >> \"$GITHUB_OUTPUT\"",
];
export const CANONICAL_CERTIFY_JOB = [
  "  certify-macos:",
  "    needs: screen",
  "    if: ${{ !cancelled() && github.event_name == 'push' && github.ref == 'refs/heads/main' && needs.screen.result == 'success' && needs.screen.outputs.eligible == 'true' }}",
  "    runs-on: macos-15",
  "    timeout-minutes: 3",
  "    continue-on-error: true",
  "    outputs:",
  "      certificates: ${{ steps.export.outputs.certificates }}",
  "    steps:",
  "      - name: Check out the probe",
  "        uses: actions/checkout@de0fac2e4500dabe0009e67214ff5f5447ce83dd # v6.0.2",
  "        with:",
  "          persist-credentials: false",
  "      - name: Certify this runner's toolchain now",
  "        shell: bash",
  "        run: node scripts/ci/ci-evidence-toolchain.mjs current --profiles macos-xcode --dir \"$RUNNER_TEMP/ci-evidence-current\"",
  "      - name: Hand the certificates to the evidence job",
  "        id: export",
  "        shell: bash",
  "        run: node scripts/ci/ci-evidence-toolchain.mjs export --dir \"$RUNNER_TEMP/ci-evidence-current\" >> \"$GITHUB_OUTPUT\"",
];
export const CANONICAL_EVIDENCE_JOB = [
  "  evidence:",
  "    needs: [screen, certify-macos]",
  "    if: ${{ !cancelled() }}",
  "    runs-on: ubuntu-latest",
  "    timeout-minutes: 10",
  "    continue-on-error: true",
  "    permissions:",
  "      contents: read",
  "      actions: read",
  "      pull-requests: read",
  "    outputs:",
  "      reuse: ${{ steps.handover.outputs.reuse }}",
  "      witness: ${{ steps.handover.outputs.witness }}",
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
  "      - name: Take the certify jobs' certificates (ordinary main push only)",
  "        if: github.event_name == 'push' && github.ref == 'refs/heads/main'",
  "        shell: bash",
  "        env:",
  "          CI_EVIDENCE_CERTIFICATES_MACOS: ${{ needs['certify-macos'].outputs.certificates }}",
  "        run: node scripts/ci/ci-evidence-toolchain.mjs import --dir \"$RUNNER_TEMP/ci-evidence-current\"",
  "      - name: Does the merged pull request's full proof cover this main tree?",
  "        id: verify",
  "        if: github.event_name == 'push' && github.ref == 'refs/heads/main'",
  "        env:",
  "          GH_TOKEN: ${{ github.token }}",
  "          CI_EVIDENCE_CURRENT_TOOLCHAIN_DIR: ${{ runner.temp }}/ci-evidence-current",
  "          CI_EVIDENCE_WITNESS_FILE: ${{ runner.temp }}/ci-evidence-witness/macos.json",
  "        run: node scripts/ci/ci-evidence.mjs witness macos >> \"$GITHUB_OUTPUT\"",
  "      - name: Keep the witness (reuse only)",
  "        id: keep",
  "        if: steps.verify.outputs.reuse == 'true'",
  "        uses: actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a # v7.0.1",
  "        with:",
  "          name: relayium-ci-evidence-witness-macos-attempt-${{ github.run_attempt }}",
  "          path: ${{ runner.temp }}/ci-evidence-witness",
  "          if-no-files-found: error",
  "          retention-days: 30",
  "      - name: Hand the decision to the lane only once its witness is kept",
  "        id: handover",
  "        if: steps.verify.outputs.reuse == 'true' && steps.keep.outcome == 'success'",
  "        env:",
  "          CI_EVIDENCE_WITNESS: ${{ steps.verify.outputs.witness }}",
  "          CI_EVIDENCE_WITNESS_FILE: ${{ runner.temp }}/ci-evidence-witness/macos.json",
  "        run: node scripts/ci/ci-evidence.mjs handover >> \"$GITHUB_OUTPUT\"",
];
/**
 * The frozen PREVIOUS adoption's evidence job: identical but for one more step,
 * the Ubuntu toolchain probe it ran while `contract` was witnessed and certified
 * under `linux-base`. Read only by `workflowShape`, never a generator target:
 * it lets a signed build produced under that adoption still be judged, and
 * only together with every other part of that same adoption.
 */
export const WITNESSED_CONTRACT_EVIDENCE_JOB = Object.freeze([
  ...CANONICAL_EVIDENCE_JOB.slice(0, CANONICAL_EVIDENCE_JOB.indexOf("      - name: Take the certify jobs' certificates (ordinary main push only)")),
  "      - name: Certify this runner's toolchain now (ordinary main push only)",
  "        if: github.event_name == 'push' && github.ref == 'refs/heads/main'",
  "        shell: bash",
  "        run: node scripts/ci/ci-evidence-toolchain.mjs current --profiles linux-base --dir \"$RUNNER_TEMP/ci-evidence-current\"",
  ...CANONICAL_EVIDENCE_JOB.slice(CANONICAL_EVIDENCE_JOB.indexOf("      - name: Take the certify jobs' certificates (ordinary main push only)")),
]);
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
export const CANONICAL_JOB_CONDITIONS = {
  "contract": [
    "    needs: evidence",
    "    if: ${{ !cancelled() }}",
    "    runs-on: ${{ (inputs.release_version || inputs.notarize || inputs.publish_release) && 'macos-15' || 'ubuntu-latest' }}"
  ],
  "test": [
    "    needs: evidence",
    "    if: ${{ !cancelled() }}",
    "    runs-on: ${{ needs.evidence.outputs.reuse == 'true' && 'ubuntu-latest' || 'macos-15' }}"
  ],
  "ui-smoke": [
    "    needs: [contract, evidence]",
    "    if: ${{ !cancelled() && needs.contract.result == 'success' && (github.event_name != 'pull_request' || github.event.pull_request.head.repo.full_name == github.repository) }}",
    "    runs-on: ${{ needs.evidence.outputs.reuse == 'true' && 'ubuntu-latest' || 'macos-15' }}"
  ],
  "signed-build": [
    "    needs: [test, contract]",
    "    runs-on: macos-15",
    "    if: ${{ !cancelled() && needs.test.result == 'success' && needs.contract.result == 'success' && (github.event_name != 'pull_request' || github.event.pull_request.head.repo.full_name == github.repository) }}"
  ]
};
/**
 * The adopted `ui-smoke` triple before it stopped waiting for `test`: frozen,
 * whole, and read only by `workflowShape`. Never a generator target.
 */
export const LEGACY_ADOPTED_UI_SMOKE_CONDITIONS = Object.freeze([
  "    needs: [test, contract, evidence]",
  "    if: ${{ !cancelled() && needs.test.result == 'success' && needs.contract.result == 'success' && (github.event_name != 'pull_request' || github.event.pull_request.head.repo.full_name == github.repository) }}",
  "    runs-on: ${{ needs.evidence.outputs.reuse == 'true' && 'ubuntu-latest' || 'macos-15' }}",
]);
/**
 * The current adoption's `contract` job, WHOLE (structure only): its runner and
 * its release branch both read release INTENT — a non-empty release_version,
 * notarize or publish_release — and never the event. `workflowShape` requires
 * exactly these lines, so a runner of one generation can never sit beside the
 * release branch of another.
 */
export const CANONICAL_CONTRACT_JOB = Object.freeze([
  "  contract:",
  ...CANONICAL_JOB_CONDITIONS.contract,
  "    timeout-minutes: 10",
  "    steps:",
  "      - uses: actions/checkout@de0fac2e4500dabe0009e67214ff5f5447ce83dd # v6.0.2",
  "      - name: Validate release contract",
  "        env:",
  "          RELEASE_VERSION: ${{ inputs.release_version }}",
  "          NOTARIZE: ${{ inputs.notarize }}",
  "          PUBLISH_RELEASE: ${{ inputs.publish_release }}",
  "        run: |",
  "          set -euo pipefail",
  "          if [ -n \"$RELEASE_VERSION\" ] || [ \"$NOTARIZE\" = true ] \\",
  "            || [ \"$PUBLISH_RELEASE\" = true ]; then",
  "            [ \"$RUNNER_OS\" = macOS ] || { echo \"::error::release contract reached on $RUNNER_OS; runs-on must select macos-15 for it\"; exit 1; }",
  "            if [ -n \"$RELEASE_VERSION\" ]; then",
  "              printf '%s' \"$RELEASE_VERSION\" | grep -Eq '^[0-9]+(\\.[0-9]+){1,2}$' || exit 1",
  "              [ \"$NOTARIZE\" = true ] || exit 1",
  "              actual=\"$(xcodebuild -project apps/mac/Relayium.xcodeproj -scheme Relayium -showBuildSettings | awk '/MARKETING_VERSION =/{print $3; exit}')\"",
  "              [ \"$actual\" = \"$RELEASE_VERSION\" ] || { echo \"::error::release $RELEASE_VERSION != MARKETING_VERSION $actual\"; exit 1; }",
  "            fi",
  "            if [ \"$PUBLISH_RELEASE\" = true ]; then",
  "              [ -n \"$RELEASE_VERSION\" ] && [ \"$GITHUB_REF\" = refs/heads/main ] || exit 1",
  "              node apps/mac/scripts/check-release-readiness.mjs --require-approved",
  "            fi",
  "          fi",
]);
/** The release-branch test, per generation: the current one (intent only) and
 *  the frozen one every earlier adoption carried (the caller's event too). */
export const RELEASE_INTENT_BRANCH = Object.freeze(CANONICAL_CONTRACT_JOB.slice(14, 16));
export const EVENT_CONTRACT_BRANCH = Object.freeze([
  "          if [ \"$GITHUB_EVENT_NAME\" = workflow_dispatch ] \\",
  "            || [ -n \"$RELEASE_VERSION\" ] || [ \"$PUBLISH_RELEASE\" = true ]; then",
]);
/** The frozen contract triple every earlier adoption carried: macos-15 for any
 *  dispatch of the caller. Read only by `workflowShape`; never a generator target. */
export const EVENT_CONTRACT_CONDITIONS = Object.freeze([
  "    needs: evidence",
  "    if: ${{ !cancelled() }}",
  "    runs-on: ${{ (github.event_name == 'workflow_dispatch' || inputs.release_version || inputs.publish_release) && 'macos-15' || 'ubuntu-latest' }}",
]);
/**
 * The frozen PREVIOUS adoption's `contract`, WHOLE: always fresh like the
 * current one, but with the event-reading runner AND the event-reading release
 * branch — exactly what `macos.yml` carried at 3ce8c939. Read only by
 * `workflowShape`, so a signed build produced under it can still be judged.
 */
export const EVENT_CONTRACT_JOB = Object.freeze([
  "  contract:",
  ...EVENT_CONTRACT_CONDITIONS,
  ...CANONICAL_CONTRACT_JOB.slice(4, 14),
  ...EVENT_CONTRACT_BRANCH,
  ...CANONICAL_CONTRACT_JOB.slice(16),
]);
/**
 * The frozen adoption before that, `adopted-witnessed-contract`: its WHOLE
 * `contract` job (structure only), exactly as `macos.yml` carried it at
 * 672e46a2 and 3f2e92dd (the only two commits of that generation) — the
 * witness prefix, the step guards, the event runner, the event release branch
 * with every original check (version format, notarize for a version, the
 * MARKETING_VERSION match, publication only with a version from main after the
 * approved readiness check, the non-macOS guard) and the Ubuntu toolchain
 * capture tail. A frozen signed build is judged against all of it, never
 * against a selection of its lines. Read only by `workflowShape`.
 */
export const WITNESSED_CONTRACT_JOB = Object.freeze([
  "  contract:",
  "    needs: evidence",
  "    if: ${{ !cancelled() }}",
  "    runs-on: ${{ (github.event_name == 'workflow_dispatch' || inputs.release_version || inputs.publish_release) && 'macos-15' || 'ubuntu-latest' }}",
  "    timeout-minutes: 10",
  "    steps:",
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
  "      - uses: actions/checkout@de0fac2e4500dabe0009e67214ff5f5447ce83dd # v6.0.2",
  "        if: needs.evidence.outputs.reuse != 'true'",
  "      - name: Validate release contract",
  "        if: needs.evidence.outputs.reuse != 'true'",
  "        env:",
  "          RELEASE_VERSION: ${{ inputs.release_version }}",
  "          NOTARIZE: ${{ inputs.notarize }}",
  "          PUBLISH_RELEASE: ${{ inputs.publish_release }}",
  "        run: |",
  "          set -euo pipefail",
  "          if [ \"$GITHUB_EVENT_NAME\" = workflow_dispatch ] \\",
  "            || [ -n \"$RELEASE_VERSION\" ] || [ \"$PUBLISH_RELEASE\" = true ]; then",
  "            [ \"$RUNNER_OS\" = macOS ] || { echo \"::error::release contract reached on $RUNNER_OS; runs-on must select macos-15 for it\"; exit 1; }",
  "            if [ -n \"$RELEASE_VERSION\" ]; then",
  "              printf '%s' \"$RELEASE_VERSION\" | grep -Eq '^[0-9]+(\\.[0-9]+){1,2}$' || exit 1",
  "              [ \"$NOTARIZE\" = true ] || exit 1",
  "              actual=\"$(xcodebuild -project apps/mac/Relayium.xcodeproj -scheme Relayium -showBuildSettings | awk '/MARKETING_VERSION =/{print $3; exit}')\"",
  "              [ \"$actual\" = \"$RELEASE_VERSION\" ] || { echo \"::error::release $RELEASE_VERSION != MARKETING_VERSION $actual\"; exit 1; }",
  "            fi",
  "            if [ \"$PUBLISH_RELEASE\" = true ]; then",
  "              [ -n \"$RELEASE_VERSION\" ] && [ \"$GITHUB_REF\" = refs/heads/main ] || exit 1",
  "              node apps/mac/scripts/check-release-readiness.mjs --require-approved",
  "            fi",
  "          fi",
  "      - name: Certify this job's toolchain",
  "        if: needs.evidence.outputs.reuse != 'true'",
  "        shell: bash",
  "        env:",
  "          CI_EVIDENCE_JOB_INDEX: ${{ strategy.job-index }}",
  "          CI_EVIDENCE_JOB_TOTAL: ${{ strategy.job-total }}",
  "          CI_EVIDENCE_MATRIX: ${{ toJSON(matrix) }}",
  "        run: node scripts/ci/ci-evidence-toolchain.mjs capture --role source --profile linux-base --lane macos --job contract --out \"$RUNNER_TEMP/ci-evidence-toolchain/toolchain.json\"",
  "      - name: Keep this job's toolchain certificate",
  "        if: needs.evidence.outputs.reuse != 'true'",
  "        uses: actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a # v7.0.1",
  "        with:",
  "          name: relayium-ci-evidence-toolchain-macos-contract-${{ strategy.job-index }}-attempt-${{ github.run_attempt }}",
  "          path: ${{ runner.temp }}/ci-evidence-toolchain/toolchain.json",
  "          if-no-files-found: ignore",
  "          retention-days: 7",
]);
/** The current adoption, and the two frozen ones before it (see `workflowShape`). */
export const ADOPTED_SHAPE = "adopted";
export const EVENT_CONTRACT_SHAPE = "adopted-event-contract";
export const WITNESSED_CONTRACT_SHAPE = "adopted-witnessed-contract";
const isAdopted = (shape) => shape === ADOPTED_SHAPE || shape === EVENT_CONTRACT_SHAPE || shape === WITNESSED_CONTRACT_SHAPE;
/** The adoptions whose `contract` is always fresh (no witness path at all). */
const freshContract = (shape) => shape === ADOPTED_SHAPE || shape === EVENT_CONTRACT_SHAPE;
/** The jobs each adoption gives the witness prefix. signed-build is `fresh` in
 *  all three; `contract` is `fresh` in the current one and the one before it. */
const WITNESSED_JOB_IDS = Object.freeze({
  [ADOPTED_SHAPE]: Object.freeze(["test", "ui-smoke"]),
  [EVENT_CONTRACT_SHAPE]: Object.freeze(["test", "ui-smoke"]),
  [WITNESSED_CONTRACT_SHAPE]: Object.freeze(["contract", "test", "ui-smoke"]),
});
/** `lines` contains `seq` as one consecutive run exactly once. */
const containsOnce = (lines, seq) => {
  let n = 0;
  for (let i = 0; i + seq.length <= lines.length; i += 1) {
    if (seq.every((l, k) => lines[i + k] === l)) n += 1;
  }
  return n === 1;
};

const structural = (lines) => lines.filter((l) => l.trim() !== "" && !l.trim().startsWith("#"));

/**
 * `legacy` (no evidence adoption at all), `adopted` (exactly the current
 * canonical one), `adopted-witnessed-contract` (exactly the frozen previous
 * one, as a whole), or `non-canonical` (anything else that mentions the
 * evidence path, including any mix of the two adoptions).
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
  if (JSON.stringify(ids) !== JSON.stringify(["screen", "certify-macos", "evidence", "contract", "test", "ui-smoke", "signed-build"])) {
    return "non-canonical";
  }
  const body = (id) => {
    const block = blocks.find((b) => b.id === id);
    return block ? structural(lines.slice(block.start, block.end)) : [];
  };
  if (JSON.stringify(body("screen")) !== JSON.stringify(CANONICAL_SCREEN_JOB)) return "non-canonical";
  if (JSON.stringify(body("certify-macos")) !== JSON.stringify(CANONICAL_CERTIFY_JOB)) return "non-canonical";
  // The evidence job names the adoption; every other part must then be THAT
  // adoption's. The frozen ui-smoke triple predates the current adoption, so it
  // belongs to the frozen one only.
  const evidence = JSON.stringify(body("evidence"));
  let shape = evidence === JSON.stringify(CANONICAL_EVIDENCE_JOB) ? ADOPTED_SHAPE
    : evidence === JSON.stringify(WITNESSED_CONTRACT_EVIDENCE_JOB) ? WITNESSED_CONTRACT_SHAPE : null;
  if (shape === null) return "non-canonical";
  // The always-fresh contract names its generation WHOLE: the current job
  // (release-intent runner AND branch), or the frozen one before it (event
  // runner AND branch). A runner of one beside the branch of the other is
  // neither. The frozen witnessed adoption predates both: its contract must be
  // WITNESSED_CONTRACT_JOB whole (every original check, guard and capture
  // step), so the event branch is there exactly once and the intent one never.
  const contract = body("contract");
  if (shape === ADOPTED_SHAPE) {
    const whole = JSON.stringify(contract);
    if (whole === JSON.stringify(EVENT_CONTRACT_JOB)) shape = EVENT_CONTRACT_SHAPE;
    else if (whole !== JSON.stringify(CANONICAL_CONTRACT_JOB)) return "non-canonical";
  } else if (JSON.stringify(contract) !== JSON.stringify(WITNESSED_CONTRACT_JOB)
    || !containsOnce(contract, EVENT_CONTRACT_BRANCH)
    || RELEASE_INTENT_BRANCH.some((line) => contract.includes(line))) {
    return "non-canonical";
  }
  for (const [id, current] of Object.entries(CANONICAL_JOB_CONDITIONS)) {
    const want = id === "contract" && shape !== ADOPTED_SHAPE ? EVENT_CONTRACT_CONDITIONS : current;
    const b = body(id);
    const conditions = JSON.stringify(b.slice(0, b.indexOf("    steps:")).filter((l) => /^ {4}(needs|if|runs-on):/.test(l)));
    const legacy = shape === WITNESSED_CONTRACT_SHAPE && id === "ui-smoke"
      && conditions === JSON.stringify(LEGACY_ADOPTED_UI_SMOKE_CONDITIONS);
    if (conditions !== JSON.stringify(want) && !legacy) return "non-canonical";
  }
  const witness = JSON.stringify(CANONICAL_WITNESS_STEPS);
  for (const id of WITNESSED_JOB_IDS[shape]) {
    const b = body(id);
    const at = b.indexOf("    steps:");
    if (at < 0 || JSON.stringify(b.slice(at + 1, at + 1 + CANONICAL_WITNESS_STEPS.length)) !== witness) return "non-canonical";
    // The prefix must END where the canonical one does: the next line opens
    // the job's own first step, so no key can be appended to the witness.
    if (!/^ {6}- /.test(b[at + 1 + CANONICAL_WITNESS_STEPS.length] ?? "")) return "non-canonical";
    if (b.join("\n").split("node scripts/ci/ci-evidence.mjs confirm macos").length !== 2) return "non-canonical";
  }
  // `fresh`: no witness, no capture, no reading of the decision. The current
  // contract keeps its `needs: evidence` edge (its place in the graph) and
  // nothing else of the evidence path: no witness step, no step guard, no capture.
  const signed = body("signed-build").join("\n");
  if (signed.includes("evidence") || signed.includes("ci-evidence")) return "non-canonical";
  if (freshContract(shape)) {
    const contract = body("contract").join("\n");
    if (contract.includes("needs.evidence") || contract.includes("ci-evidence")
      || WITNESS_STEPS.some((name) => contract.includes(name))) return "non-canonical";
  }
  return shape;
}

/**
 * Did this job EXECUTE its gate? On the executed route every reason it did
 * not is `Unavailable`: a full rebuild is always the safe answer to "this run
 * did not test the bytes", and an explicit `reuse` turns it into a failure.
 * A certified run passes `contradiction: refuse`: its contract or signed-build
 * is known and must have executed, so a wrong runner, a missing, failed,
 * duplicated or malformed mandatory step or a foreign step is `Refused` and
 * never rebuilt over. A job reporting no step records stays `Unavailable`.
 */
export function judgeExecution(id, job, shape, { contradiction = unavailable } = {}) {
  const where = `job ${job.id} (${job.name})`;
  unavailable(Array.isArray(job.steps) && job.steps.length > 0, `${where} reports no step records`);
  for (const step of job.steps) {
    contradiction(step && typeof step.name === "string" && typeof step.status === "string",
      `${where} has a malformed step record`);
  }
  const labels = JSON.stringify(job.labels ?? null);
  contradiction(RUNNER_LABELS[id].some((want) => JSON.stringify(want) === labels),
    `${where} ran on ${labels}; \`${id}\` must run on ${RUNNER_LABELS[id].map((l) => JSON.stringify(l)).join(" or ")}`);
  for (const name of REQUIRED_STEPS[id]) {
    const ran = job.steps.filter((step) => step.name === name);
    contradiction(ran.length === 1, `${where} has ${ran.length} "${name}" step(s); it must execute exactly once`);
    contradiction(ran[0].status === "completed" && ran[0].conclusion === "success",
      `${where} did not execute "${name}" (${ran[0].status}/${ran[0].conclusion})`);
  }
  // Reported-but-skipped witness steps exist only where that adoption put a
  // witness path: never in an always-fresh contract (current or event generation).
  const witnessable = shape === WITNESSED_CONTRACT_SHAPE || (freshContract(shape) && id !== "contract");
  for (const name of MUST_NOT_RUN[id]) {
    const ran = job.steps.filter((step) => step.name === name);
    const allowed = witnessable || !WITNESS_STEPS.includes(name)
      ? ran.every((step) => step.conclusion === "skipped")
      : ran.length === 0;
    contradiction(allowed, `${where} ran "${name}" (${ran.map((s) => s.conclusion).join(", ") || "present"}); `
      + "a witnessed or foreign step is not an execution of this job's gate");
  }
}

/**
 * How the producer run covered `test` and both UI shards. `executed`: each ran
 * its own gate (`judgeExecution`). `certified-full-proof`: each ran ONLY the
 * canonical witness confirmation of the current adoption, on Ubuntu, and the
 * run's evidence job decided, kept and handed over that witness — which this
 * reader then re-authenticates end to end (`judgeCertifiedCoverage`). The
 * contract and signed-build are never certified: under both modes they must
 * have executed their exact steps. A run mixing the two modes is neither.
 */
export const COVERAGE_EXECUTED = "executed";
export const COVERAGE_CERTIFIED = "certified-full-proof";
/** The jobs a certified coverage may stand in for, and nothing else. */
export const CERTIFIABLE_JOBS = Object.freeze(["test", "ui-smoke/app-shell", "ui-smoke/device-inbox"]);
/** The evidence job steps a certified run's decision must have executed. */
export const CERTIFIED_EVIDENCE_STEPS = Object.freeze([
  "Does the merged pull request's full proof cover this main tree?",
  "Keep the witness (reuse only)",
  "Hand the decision to the lane only once its witness is kept",
]);
/** The only non-skipped steps a witnessed job may report besides `WITNESS_STEPS`. */
const WITNESS_PATH_HOUSEKEEPING = Object.freeze([
  "Set up job", "Complete job",
  "Post Node for the verifier (witness path only)", "Post Check out the verifier (witness path only)",
]);
const WITNESS_ARTIFACT = /^relayium-ci-evidence-witness-macos-attempt-([1-9][0-9]*)$/;
/** The steps the certify job must have executed for its current capture to count. */
export const CERTIFY_STEPS = Object.freeze([
  "Check out the probe",
  "Certify this runner's toolchain now",
  "Hand the certificates to the evidence job",
]);
/** API timestamps are whole seconds: the tolerance on either side of a step window. */
const STEP_SKEW_MS = 2_000;
/**
 * How old the current certificate may have been when the witness was verified:
 * F's `CURRENT_CERT_MAX_AGE_MS`, the limit F applied in that very decision. F
 * is loaded only on the certified route, so this is the bounded local copy;
 * `certifiedCoverage` refuses unless the loaded F carries exactly this value.
 */
export const CERTIFY_TO_VERIFIED_MAX_MS = 30 * 60 * 1000;
const WITNESS_ENTRY = "macos.json";

/**
 * A structured reason, so callers classify by `cause` and never by message.
 * `unavailable` (absent, expired, stale, pending or an unsupported state) is
 * an `Unavailable`; anything else that exists and disagrees is `Refused`.
 */
export class CertifiedUnavailable extends Error {
  constructor(message) { super(message); this.cause = "certified-proof-unavailable"; }
}

/**
 * Which mode the run's own step records say it INTENDED. Certified as soon as
 * ANY canonical witnessable job (test or either UI shard) reports a witness
 * step that was not skipped — whether it succeeded, failed or was cancelled —
 * or the evidence job kept or handed over a witness. A run that meant to be
 * covered by a witness is then judged as such, in full, and every
 * contradiction is `Refused`; it never falls back to the executed route,
 * whose "did not execute" is `Unavailable` and would let `auto` rebuild over a
 * known disagreement. A run whose witness steps were all skipped or absent is
 * judged as executed, exactly as before.
 */
export function coverageOf(jobs, shape) {
  if (!(shape === ADOPTED_SHAPE || shape === EVENT_CONTRACT_SHAPE)) return COVERAGE_EXECUTED;
  const certifiable = EXPECTED_JOBS.filter((e) => CERTIFIABLE_JOBS.includes(e.id));
  const attempted = (job, names) => Array.isArray(job?.steps)
    && job.steps.some((s) => names.includes(s?.name) && s?.conclusion !== "skipped");
  const intent = jobs.some((job) => (certifiable.some((e) => e.match(String(job?.name ?? "")))
      && attempted(job, WITNESS_STEPS))
    || (EVIDENCE_JOB.match(String(job?.name ?? "")) && attempted(job, CERTIFIED_EVIDENCE_STEPS.slice(1))));
  return intent ? COVERAGE_CERTIFIED : COVERAGE_EXECUTED;
}

/**
 * Did this witnessable job run ONLY the canonical witness confirmation? Every
 * witness step exactly once and successful, on Ubuntu; its own gate steps and
 * the other shard's suite skipped or absent; no other step executed. A job
 * that ran both its suite and the witness is neither mode. The run meant to be
 * certified (`coverageOf`), so every disagreement here is `Refused`.
 */
export function judgeWitnessed(id, job) {
  const where = `job ${job.id} (${job.name})`;
  refuse(CERTIFIABLE_JOBS.includes(id), `${where}: \`${id}\` can never be covered by a witness`);
  refuse(Array.isArray(job.steps) && job.steps.length > 0, `${where} reports no step records`);
  for (const step of job.steps) {
    refuse(step && typeof step.name === "string" && typeof step.status === "string",
      `${where} has a malformed step record`);
  }
  refuse(JSON.stringify(job.labels ?? null) === JSON.stringify(["ubuntu-latest"]),
    `${where} ran its witness on ${JSON.stringify(job.labels ?? null)}; the witness path runs on ["ubuntu-latest"]`);
  for (const name of WITNESS_STEPS) {
    const ran = job.steps.filter((step) => step.name === name);
    refuse(ran.length === 1 && ran[0].status === "completed" && ran[0].conclusion === "success",
      `${where} did not confirm its witness exactly once ("${name}": ${ran.map((s) => s.conclusion).join(", ") || "absent"})`);
  }
  const allowed = new Set([...WITNESS_STEPS, ...WITNESS_PATH_HOUSEKEEPING]);
  for (const step of job.steps) {
    if (allowed.has(step.name)) continue;
    refuse(step.conclusion === "skipped",
      `${where} executed "${step.name}" (${step.conclusion}) beside its witness; a mixed or foreign execution is neither mode`);
  }
}

/** The certified evidence job: decided, kept and handed over its witness, on Ubuntu. */
export function judgeCertifiedEvidence(job) {
  const where = `job ${job.id} (${job.name})`;
  refuse(Array.isArray(job.steps) && job.steps.length > 0, `${where} reports no step records`);
  refuse(JSON.stringify(job.labels ?? null) === JSON.stringify(["ubuntu-latest"]),
    `${where} ran on ${JSON.stringify(job.labels ?? null)}; want ["ubuntu-latest"]`);
  for (const name of CERTIFIED_EVIDENCE_STEPS) {
    const ran = job.steps.filter((step) => step?.name === name);
    refuse(ran.length === 1 && ran[0].status === "completed" && ran[0].conclusion === "success",
      `${where} did not execute "${name}" exactly once (${ran.map((s) => s?.conclusion).join(", ") || "absent"})`);
  }
}

/**
 * The SIGNED commit's own tree as F's judge reads a checkout: `HEAD` means
 * `sha`, files and workflows come from `sha`'s blobs, the candidate-scope
 * module is `sha`'s copy. Nothing in the invoking checkout is read or
 * changed; the one temporary file is the scope module, outside the checkout.
 */
export function pinnedSourceTree(runGit, sha) {
  refuse(SHA40.test(sha), `the source tree ${JSON.stringify(sha)} is not a full SHA`);
  const git = (args) => runGit(args.map((a) => (a === "HEAD" ? sha : a)));
  const readFile = (path) => git(["show", `${sha}:${path}`]);
  const readWorkflow = (absolute) => git(["show", `${sha}:${absolute.replace(/^\/+/, "")}`]).toString("utf8");
  // The module is written at its own repository path under a fresh temporary
  // root, and loaded through the rooted literal form F's trust closure can name
  // (`moduleImports`): any other dynamic load is refused there, which would make
  // every internal candidate touching this reader unprovable.
  const loadScope = async () => {
    const root = mkdtempSync(join(tmpdir(), "macos-evidence-scope-"));
    mkdirSync(join(root, "web/scripts"), { recursive: true });
    writeFileSync(join(root, "web/scripts/macos-release-candidate.mjs"),
      readFile("web/scripts/macos-release-candidate.mjs"), { flag: "wx" });
    return import(pathToFileURL(join(root, "web/scripts/macos-release-candidate.mjs")).href);
  };
  return { git, readFile, readWorkflow, loadScope, workflowsDir: "/.github/workflows" };
}

function realGitBytes(args) {
  const result = spawnSync("git", args, { encoding: "buffer", maxBuffer: 256 * 1024 * 1024 });
  if (result.status !== 0) {
    throw new CertifiedUnavailable(`git ${args.slice(0, 2).join(" ")} could not read the signed commit locally`);
  }
  return result.stdout;
}

/**
 * The authenticated certified coverage of a producer run whose roster judged
 * `certified-full-proof`. Reads, never writes, and never trusts a supplied
 * witness, env or record:
 *  1. the ONE retained main witness artifact of the run, by its canonical
 *     attempt-qualified name: unexpired, from this run/commit/repository,
 *     bytes equal to the current API digest, a strict single-entry ZIP holding
 *     a valid typed witness for this lane, commit, tree, run, attempt and
 *     `macos.yml@refs/heads/main`, vouching for exactly `test` + `ui-smoke`;
 *  2. the witness attempt is the ORIGINAL execution of the evidence job and of
 *     every witnessed job (`judgeExecutionOrigin`, so "re-run failed jobs"
 *     relabels bind the carried execution, never the wrapper);
 *  3. F's own source-proof judge (`judgeSourceProof`) re-run NOW against the
 *     signed commit's tree: source kind, latest attempt, every job, aggregate,
 *     select, required checks and runners, referenced workflows, tree,
 *     parents, scope, fingerprint and all five certification hashes; the proof
 *     artifact must be the one the witness names;
 *  4. every source certificate re-authenticated and its value digest equal to
 *     the witness's source AND current digest (equal digests are equal
 *     toolchain values; the historical current capture stays bound by step 1-2);
 *  5. F's re-read: the source run and its listing did not move.
 * Absence (no witness, expired or stale proof, a pending source, an unreadable
 * local commit, an unsupported rerun) is `Unavailable`; disagreement `Refused`.
 */
export async function judgeCertifiedCoverage(api, {
  repository, repositoryId, sha, run, rosterJobs, evidenceJob, certifyJob, now, sourceGit = realGitBytes,
}) {
  const F = await loadF();
  const { NoReuse, ProofUnavailable } = F;
  try {
    return validateCoverage(await certifiedCoverage(api, {
      repository, repositoryId, sha, run, rosterJobs, evidenceJob, certifyJob, clock: () => now, sourceGit, F, history: null,
    }));
  } catch (error) {
    if (error instanceof CertifiedUnavailable || error instanceof ProofUnavailable) {
      throw new Unavailable(`the certified full proof is unavailable: ${error.message}`);
    }
    if (error instanceof NoReuse) throw new Refused(`the certified full proof disagrees: ${error.message}`);
    throw error;
  }
}

/** E's API as F's judge calls it: F paths carry no leading slash; absence is `ProofUnavailable`. */
function ciApi(api, ProofUnavailable) {
  const absent = (error) => {
    if (error?.status === 404 || error?.status === 410) throw new ProofUnavailable(`the API reports ${error.status} for a proof record`);
    throw error;
  };
  return {
    json: (path) => api.get(`/${path}`).catch(absent),
    download: (path, cap) => api.download(`/${path}`, cap).catch(absent),
  };
}

/**
 * The HISTORICAL verification of a certified coverage a release already froze
 * (for the later handoff verifier; never a new selection). Same shared reader
 * as `judgeCertifiedCoverage`, with these differences only:
 *  - `expectedCoverage` is REQUIRED (strictly `validateCoverage`d) and the
 *    re-derived coverage must equal it exactly — no alternative proof, source,
 *    witness or certificate is ever re-selected;
 *  - `sourceGit` is REQUIRED: an explicit byte-mode Git adapter for a checkout
 *    holding the signed commit and its parent (no ambient working directory);
 *  - F's two ORIGINAL source age gates are judged at the witness's own
 *    verified_at (`judgeHistoricalSourceProof`), everything else at the fresh
 *    machine `clock()` — every artifact must be unexpired NOW, but no new
 *    selection headroom applies;
 *  - nothing is rebuilt: absence is `Refused`, like any disagreement.
 * No CLI, environment or history flag reaches this; `clock` defaults to the
 * machine clock.
 */
export async function verifyHistoricalCertifiedCoverage(api, {
  repository, repositoryId, sha, run, rosterJobs, evidenceJob, certifyJob, expectedCoverage, clock = Date.now, sourceGit,
}) {
  refuse(typeof sourceGit === "function", "a historical certified verification needs an explicit source Git adapter");
  refuse(typeof clock === "function", "a historical certified verification needs a machine clock function");
  refuse(expectedCoverage?.mode === COVERAGE_CERTIFIED, "a historical certified verification needs the frozen certified coverage");
  validateCoverage(expectedCoverage);
  const F = await loadF();
  let coverage;
  try {
    coverage = await certifiedCoverage(api, {
      repository, repositoryId, sha, run, rosterJobs, evidenceJob, certifyJob, clock, sourceGit, F,
      history: { expected: expectedCoverage },
    });
  } catch (error) {
    if (error instanceof Refused) throw error;
    if (error instanceof CertifiedUnavailable || error instanceof F.NoReuse || error instanceof Unavailable) {
      throw new Refused(`the frozen certified coverage no longer holds: ${error.message}`);
    }
    throw error;
  }
  validateCoverage(coverage);
  refuse(JSON.stringify(coverage) === JSON.stringify(expectedCoverage),
    "the certified coverage read back now differs from the coverage the release froze");
  return coverage;
}

async function certifiedCoverage(api, {
  repository, repositoryId, sha, run, rosterJobs, evidenceJob, certifyJob, clock, sourceGit, F, history,
}) {
  const {
    REGISTRY_FILE: CI_REGISTRY_FILE, TOOLCHAIN_REGISTRY_FILE, headFacts, judgeSourceProof, judgeHistoricalSourceProof,
    loadRegistry: loadCiRegistry, loadToolchainRegistry, readSingleEntryZip, reauthenticateSourceCertificates,
    rereadArtifactIdentities, rereadSourceProof, validateWitness, artifactIdentityOf,
  } = F;
  const machineNow = () => {
    const at = clock();
    refuse(Number.isFinite(at), "the machine clock is unreadable");
    return at;
  };
  // A NEW selection needs every retained chain artifact to outlive the
  // release's own readback by the same margin as the signed artifact; a
  // historical verification needs it unexpired now only.
  const headroom = (identity, what) => {
    if (history !== null) return;
    if (hours(Date.parse(identity.expires_at) - machineNow()) < MIN_ARTIFACT_REMAINING_HOURS) {
      throw new CertifiedUnavailable(`${what} ${identity.id} expires in under ${MIN_ARTIFACT_REMAINING_HOURS} hours`);
    }
  };
  const all = await paginate(api, `/repos/${repository}/actions/runs/${run.id}/artifacts`, "artifacts");
  const witnesses = all.filter((a) => WITNESS_ARTIFACT.test(String(a?.name ?? "")));
  if (witnesses.length === 0) throw new CertifiedUnavailable(`run ${run.id} retains no main witness artifact`);
  if (witnesses.length !== 1) {
    throw new CertifiedUnavailable(`run ${run.id} retains ${witnesses.length} witness artifacts; a re-decided witness is not supported`);
  }
  const art = witnesses[0];
  const attempt = Number(WITNESS_ARTIFACT.exec(art.name)[1]);
  refuse(Number.isSafeInteger(art.id) && art.workflow_run?.id === run.id && art.workflow_run?.head_sha === sha
    && art.workflow_run?.repository_id === repositoryId && art.workflow_run?.head_repository_id === repositoryId,
  `witness artifact ${art.id} is not from run ${run.id} at ${sha} in this repository`);
  refuse(typeof art.digest === "string" && /^sha256:[0-9a-f]{64}$/.test(art.digest), `witness artifact ${art.id} has no digest`);
  const expires = Date.parse(art.expires_at);
  refuse(Number.isFinite(expires), `witness artifact ${art.id} has no expiry`);
  if (art.expired !== false || expires <= machineNow()) throw new CertifiedUnavailable(`witness artifact ${art.id} has expired`);
  const witnessIdentity = artifactIdentityOf(art);
  refuse(witnessIdentity !== null, `witness artifact ${art.id} has no complete artifact identity`);
  headroom(witnessIdentity, "witness artifact");
  const record = await api.get(`/repos/${repository}/actions/artifacts/${art.id}`);
  refuse(JSON.stringify(artifactIdentityOf(record)) === JSON.stringify(witnessIdentity) && record?.expired === false,
    `witness artifact ${art.id} changed between the listing and its record`);
  let zip;
  try {
    zip = await api.download(`/repos/${repository}/actions/artifacts/${art.id}/zip`);
  } catch (error) {
    if (error?.status === 404 || error?.status === 410) throw new CertifiedUnavailable(`witness artifact ${art.id} could not be downloaded`);
    throw error;
  }
  refuse(`sha256:${sha256(zip)}` === art.digest, `witness artifact ${art.id}'s bytes do not match its API digest`);
  let witness;
  try {
    witness = validateWitness(JSON.parse(readSingleEntryZip(zip, WITNESS_ENTRY).toString("utf8")));
  } catch (error) {
    throw new Refused(`witness artifact ${art.id} is not one strict witness: ${error.message}`);
  }
  const tree = headFacts((args) => sourceGit(args.map((a) => (a === "HEAD" ? sha : a)))).tree;
  const t = witness.target;
  refuse(witness.lane === "macos" && t.repository_id === repositoryId && t.sha === sha && t.tree === tree
    && t.run_id === run.id && t.run_attempt === attempt
    && t.workflow_ref === `${repository}/${PRODUCER_WORKFLOW}@refs/heads/main`,
  `the witness targets ${t.sha}/${t.tree} run ${t.run_id} attempt ${t.run_attempt} (${t.workflow_ref}), `
    + `not this signed commit ${sha}/${tree} run ${run.id} attempt ${attempt}`);
  refuse(JSON.stringify(Object.keys(witness.jobs).sort()) === JSON.stringify(["test", "ui-smoke"]),
    `the witness vouches for [${Object.keys(witness.jobs).join(", ")}], want exactly test and ui-smoke`);

  // 2. The witness attempt is the original execution of every certified job,
  //    of the evidence decision and of the certify capture; "re-run failed
  //    jobs" relabels bind the carried execution through the ORIGINAL
  //    inventory, never the latest wrapper's label or id.
  const executions = {};
  const originals = {};
  for (const job of [...rosterJobs.filter((j) => CERTIFIABLE_JOBS.includes(j.id)).map((j) => j.job), evidenceJob, certifyJob]) {
    refuse(job !== undefined && job !== null, `run ${run.id} lacks a job the certified chain needs`);
    const origin = await judgeExecutionOrigin(api, {
      repository, runId: run.id, sha, workflowPath: PRODUCER_WORKFLOW, jobName: job.name,
      originalAttempt: attempt, latestAttempt: run.run_attempt, latestJob: job,
    });
    executions[job.name] = sha256(Buffer.from(origin.identity));
    originals[job.name] = origin.job;
  }
  judgeCertifyCapture(originals[certifyJob.name]);
  refuse(F.CURRENT_CERT_MAX_AGE_MS === CERTIFY_TO_VERIFIED_MAX_MS,
    `F's current-certificate age limit ${F.CURRENT_CERT_MAX_AGE_MS} ms is not this reader's ${CERTIFY_TO_VERIFIED_MAX_MS} ms`);
  judgeWitnessTiming({
    certify: originals[certifyJob.name], evidence: originals[evidenceJob.name], witness, art,
    maxAgeMs: F.CURRENT_CERT_MAX_AGE_MS,
  });

  // 3. F's judge, now, against the signed commit's own tree.
  const pinned = pinnedSourceTree(sourceGit, sha);
  const registry = loadCiRegistry(pinned.readFile(CI_REGISTRY_FILE).toString("utf8"));
  const toolchainRegistry = loadToolchainRegistry(pinned.readFile(TOOLCHAIN_REGISTRY_FILE).toString("utf8"));
  const head = headFacts(pinned.git);
  refuse(head.sha === sha && head.tree === tree, "the signed commit's local tree changed while it was being read");
  const proofArgs = {
    api: ciApi(api, F.ProofUnavailable),
    git: pinned.git, registry, laneId: "macos", repository, repositoryId, sha, head,
    event: { before: head.parents[0] }, now: () => new Date(machineNow()), workflowsDir: pinned.workflowsDir,
    readFile: pinned.readFile, loadScope: pinned.loadScope, readWorkflow: pinned.readWorkflow, scopeValue: undefined,
  };
  const proof = history === null ? await judgeSourceProof(proofArgs) : await judgeHistoricalSourceProof({ ...proofArgs, witness });
  const s = witness.source;
  refuse(s.kind === proof.src.kind && s.run_id === proof.run.id && s.run_attempt === proof.attempt
    && s.artifact_id === proof.art.id && s.artifact_digest === proof.art.digest && s.merge_sha === proof.src.testedSha
    && s.head_sha === proof.prHead && s.pull_request === (proof.src.prNumber ?? null)
    && s.produced_at === proof.manifest.produced_at,
  `the witness names source run ${s.run_id}/${s.run_attempt} proof ${s.artifact_id}; F's judge selects `
    + `${proof.run.id}/${proof.attempt} proof ${proof.art.id}`);
  refuse(JSON.stringify(witness.jobs) === JSON.stringify(Object.fromEntries(Object.entries(proof.required)
    .filter(([id]) => registry.lanes.macos.jobs[id].mode !== "fresh"))),
  "the witness's job obligation is not the one the source proof requires now");

  // 4. Source certificates, re-authenticated; their values equal the witness's.
  const proofIdentity = artifactIdentityOf(proof.art);
  refuse(proofIdentity !== null, `proof artifact ${proof.art.id} has no complete artifact identity`);
  headroom(proofIdentity, "proof artifact");
  const sources = await reauthenticateSourceCertificates({
    api: ciApi(api, F.ProofUnavailable),
    repository, repositoryId, proof, laneId: "macos", registry, toolchainRegistry, now: () => new Date(machineNow()),
  });
  const certificates = frozenCertificates(witness.certificates, sources, { attempt: proof.attempt, isIdentity: F.isArtifactIdentity });
  for (const cert of Object.values(certificates)) for (const a of cert.artifacts) headroom(a, "source certificate artifact");

  // 5. Nothing moved: the source run and its listing, the proof and every
  //    source certificate artifact by identity, the producer run's latest
  //    attempt, and the witness artifact by listing and record.
  const fApi = ciApi(api, F.ProofUnavailable);
  await rereadSourceProof({ api: fApi, repository, proof });
  const sourceArtifacts = [
    proofIdentity,
    ...Object.keys(certificates).sort().flatMap((jobId) => certificates[jobId].artifacts),
  ];
  try {
    await rereadArtifactIdentities({
      api: fApi, repository, runId: proof.run.id, identities: sourceArtifacts, now: () => new Date(machineNow()),
    });
  } catch (error) {
    if (error instanceof F.NoReuse) throw new Refused(error.message);
    throw error;
  }
  const again = await api.get(`/repos/${repository}/actions/runs/${run.id}`);
  refuse(again?.id === run.id && again?.run_attempt === run.run_attempt && again?.status === "completed"
    && again?.conclusion === run.conclusion,
  `producer run ${run.id} moved (attempt ${again?.run_attempt}, ${again?.status}/${again?.conclusion}) while its chain was verified`);
  const relisted = (await paginate(api, `/repos/${repository}/actions/runs/${run.id}/artifacts`, "artifacts"))
    .filter((a) => WITNESS_ARTIFACT.test(String(a?.name ?? "")));
  const rerecord = await api.get(`/repos/${repository}/actions/artifacts/${art.id}`);
  refuse(relisted.length === 1 && JSON.stringify(artifactIdentityOf(relisted[0])) === JSON.stringify(witnessIdentity)
    && JSON.stringify(artifactIdentityOf(rerecord)) === JSON.stringify(witnessIdentity)
    && relisted[0].expired === false && rerecord?.expired === false && Date.parse(art.expires_at) > machineNow(),
  `witness artifact ${art.id} was replaced, changed or expired while its chain was verified`);
  return {
    mode: COVERAGE_CERTIFIED,
    witness: {
      artifactId: art.id, name: art.name, digest: art.digest, attempt, expiresAt: art.expires_at,
      createdAt: art.created_at, verifiedAt: witness.verified_at, identity: witnessIdentity, target: { ...witness.target },
    },
    executions,
    source: {
      kind: proof.src.kind, runId: proof.run.id, attempt: proof.attempt, testedSha: proof.src.testedSha,
      tree: proof.manifest.checkout.tree, artifactId: proof.art.id, digest: proof.art.digest,
      producedAt: proof.manifest.produced_at, fingerprint: proof.manifest.fingerprints.macos,
      certification: proof.manifest.certification, proofName: proof.art.name,
      runUpdatedAt: proof.run.updated_at, headSha: proof.prHead, pullRequest: proof.src.prNumber ?? null,
      proofIdentity,
    },
    certificates,
  };
}

/**
 * The certificates a certified coverage freezes: per witnessed job its profile,
 * the witnessed current value, the re-authenticated source value digests AND
 * the exact source certificate artifacts they were read from (F's complete
 * `artifactIdentityOf` record, one per value, in check order, named for this
 * job, index and source attempt). The identities enter `evidenceIdentity`, so a
 * readback that finds the same values in a replaced or re-attributed artifact
 * is a different chain.
 */
export function frozenCertificates(witnessCertificates, sources, { attempt, isIdentity }) {
  refuse(Number.isSafeInteger(attempt) && attempt > 0 && typeof isIdentity === "function",
    "the source attempt and the identity check are required to freeze certificates");
  refuse(JSON.stringify(Object.keys(sources).sort()) === JSON.stringify(Object.keys(witnessCertificates).sort()),
    "the source certificates and the witness certify different jobs");
  const out = {};
  for (const jobId of Object.keys(witnessCertificates).sort()) {
    const cert = witnessCertificates[jobId];
    const fresh = sources[jobId];
    refuse(fresh !== undefined && fresh.profile === cert.profile
      && JSON.stringify(fresh.source) === JSON.stringify(cert.source)
      && cert.source.every((digest) => digest === cert.current),
    `${jobId}: the re-authenticated source certificates or the witnessed current toolchain value disagree`);
    refuse(Array.isArray(fresh.artifacts) && fresh.artifacts.length === fresh.source.length
      && fresh.artifacts.every((a, i) => isIdentity(a) && a.name === certificateArtifactName(jobId, i, attempt))
      && new Set(fresh.artifacts.map((a) => a.id)).size === fresh.artifacts.length,
    `${jobId}: the source certificate artifact identities are not one strict record per certificate`);
    out[jobId] = {
      profile: cert.profile, current: cert.current, source: [...fresh.source],
      artifacts: fresh.artifacts.map((a) => ({ ...a })),
    };
  }
  return out;
}

/** F's exact source certificate artifact name for a macOS job, check index and source attempt. */
export function certificateArtifactName(jobId, index, attempt) {
  return `relayium-ci-evidence-toolchain-macos-${jobId}-${index}-attempt-${attempt}`;
}

const COVERAGE_ID_KEYS = ["id", "name", "digest", "size_in_bytes", "created_at", "expires_at",
  "run_id", "head_sha", "repository_id", "head_repository_id"];
const CERTIFICATION_KEYS = ["registry_sha256", "selector_sha256", "toolchain_registry_sha256", "toolchain_sha256", "verifier_sha256"];
const SOURCE_KINDS = ["merge-gate-pull-request-full-run", "merge-gate-frozen-dispatch-full-run", "merge-gate-internal-full-candidate-run"];

/**
 * Strict, synchronous validation of a frozen evidence coverage: exactly
 * `{ mode: "executed" }`, or a complete `certified-full-proof` chain with
 * exactly the keys, types, cardinalities and internal agreements the shared
 * reader produces (no extra keys anywhere). Returns the coverage; `Refused`
 * otherwise. Shape only — authenticity is `verifyHistoricalCertifiedCoverage`.
 */
export function validateCoverage(coverage) {
  const fail = (what) => { throw new Refused(`the coverage is malformed: ${what}`); };
  const obj = (v, keys, what) => {
    if (v === null || typeof v !== "object" || Array.isArray(v)
      || JSON.stringify(Object.keys(v).sort()) !== JSON.stringify([...keys].sort())) fail(`${what} has keys ${JSON.stringify(v && typeof v === "object" ? Object.keys(v) : v)}`);
    return v;
  };
  const int = (v, what) => { if (!(Number.isSafeInteger(v) && v > 0)) fail(`${what} is not a positive integer`); };
  const hex = (v, n, what) => { if (!(typeof v === "string" && new RegExp(`^[0-9a-f]{${n}}$`).test(v))) fail(`${what} is not hex${n}`); };
  const digest = (v, what) => { if (!(typeof v === "string" && /^sha256:[0-9a-f]{64}$/.test(v))) fail(`${what} is not a sha256 digest`); };
  const time = (v, what) => { if (!Number.isFinite(instant(v))) fail(`${what} is not an ISO time`); };
  const identity = (v, what) => {
    if (v === null || typeof v !== "object" || JSON.stringify(Object.keys(v)) !== JSON.stringify(COVERAGE_ID_KEYS)) fail(`${what} is not a complete identity`);
    int(v.id, `${what}.id`);
    if (!(typeof v.name === "string" && v.name.length > 0 && v.name.length <= 200)) fail(`${what}.name`);
    digest(v.digest, `${what}.digest`);
    int(v.size_in_bytes, `${what}.size_in_bytes`);
    time(v.created_at, `${what}.created_at`);
    time(v.expires_at, `${what}.expires_at`);
    int(v.run_id, `${what}.run_id`);
    hex(v.head_sha, 40, `${what}.head_sha`);
    int(v.repository_id, `${what}.repository_id`);
    int(v.head_repository_id, `${what}.head_repository_id`);
    return v;
  };
  if (coverage?.mode === COVERAGE_EXECUTED) {
    obj(coverage, ["mode"], "an executed coverage");
    return coverage;
  }
  if (coverage?.mode !== COVERAGE_CERTIFIED) fail(`mode ${JSON.stringify(coverage?.mode)}`);
  obj(coverage, ["mode", "witness", "executions", "source", "certificates"], "a certified coverage");
  const w = obj(coverage.witness, ["artifactId", "name", "digest", "attempt", "expiresAt", "createdAt", "verifiedAt", "identity", "target"],
    "witness");
  int(w.attempt, "witness.attempt");
  identity(w.identity, "witness.identity");
  if (!(w.artifactId === w.identity.id && w.name === w.identity.name && w.digest === w.identity.digest
    && w.expiresAt === w.identity.expires_at && w.createdAt === w.identity.created_at
    && w.name === `relayium-ci-evidence-witness-macos-attempt-${w.attempt}`)) fail("witness fields disagree with its identity");
  time(w.verifiedAt, "witness.verifiedAt");
  const t = obj(w.target, ["repository_id", "sha", "tree", "run_id", "run_attempt", "workflow_ref"], "witness.target");
  int(t.repository_id, "witness.target.repository_id");
  hex(t.sha, 40, "witness.target.sha");
  hex(t.tree, 40, "witness.target.tree");
  int(t.run_id, "witness.target.run_id");
  if (t.run_attempt !== w.attempt) fail("witness.target.run_attempt is not the witness attempt");
  if (!(typeof t.workflow_ref === "string" && t.workflow_ref.endsWith(`/${PRODUCER_WORKFLOW}@refs/heads/main`))) fail("witness.target.workflow_ref");
  if (!(t.run_id === w.identity.run_id && t.sha === w.identity.head_sha && t.repository_id === w.identity.repository_id
    && t.repository_id === w.identity.head_repository_id)) fail("the witness artifact is not of its target run");
  const ex = coverage.executions;
  if (ex === null || typeof ex !== "object" || Array.isArray(ex)) fail("executions");
  const roles = Object.keys(ex).map((name) => [...EXPECTED_JOBS, EVIDENCE_JOB, CERTIFY_JOB].filter((e) => e.match(name)).map((e) => e.id));
  if (!(roles.length === 5 && roles.every((r) => r.length === 1)
    && JSON.stringify(roles.map((r) => r[0]).sort()) === JSON.stringify([...CERTIFIABLE_JOBS, "evidence", "certify-macos"].sort()))) {
    fail(`executions are ${JSON.stringify(Object.keys(ex))}`);
  }
  for (const [name, value] of Object.entries(ex)) hex(value, 64, `executions[${name}]`);
  const src = obj(coverage.source, ["kind", "runId", "attempt", "testedSha", "tree", "artifactId", "digest", "producedAt", "fingerprint",
    "certification", "proofName", "runUpdatedAt", "headSha", "pullRequest", "proofIdentity"], "source");
  if (!SOURCE_KINDS.includes(src.kind)) fail("source.kind");
  int(src.runId, "source.runId");
  int(src.attempt, "source.attempt");
  hex(src.testedSha, 40, "source.testedSha");
  hex(src.tree, 40, "source.tree");
  if (src.tree !== t.tree) fail("the source tree is not the witness target tree");
  time(src.producedAt, "source.producedAt");
  time(src.runUpdatedAt, "source.runUpdatedAt");
  hex(src.fingerprint, 64, "source.fingerprint");
  const cert = obj(src.certification, CERTIFICATION_KEYS, "source.certification");
  for (const k of CERTIFICATION_KEYS) hex(cert[k], 64, `source.certification.${k}`);
  hex(src.headSha, 40, "source.headSha");
  if (!(src.pullRequest === null || (Number.isSafeInteger(src.pullRequest) && src.pullRequest > 0))) fail("source.pullRequest");
  if ((src.kind === SOURCE_KINDS[0]) !== (src.pullRequest !== null)) fail("source.pullRequest does not match its kind");
  const pid = identity(src.proofIdentity, "source.proofIdentity");
  if (!(src.proofName === `relayium-ci-evidence-proof-attempt-${src.attempt}` && pid.name === src.proofName
    && pid.id === src.artifactId && pid.digest === src.digest && pid.run_id === src.runId && pid.head_sha === src.headSha)) {
    fail("the proof identity disagrees with the source");
  }
  const certs = coverage.certificates;
  if (certs === null || typeof certs !== "object" || JSON.stringify(Object.keys(certs)) !== JSON.stringify(["test", "ui-smoke"])) {
    fail(`certificates are ${JSON.stringify(certs && Object.keys(certs))}, want exactly test and ui-smoke`);
  }
  const ids = new Set([pid.id, w.identity.id]);
  for (const [jobId, c] of Object.entries(certs)) {
    obj(c, ["profile", "current", "source", "artifacts"], `certificates.${jobId}`);
    if (!(typeof c.profile === "string" && c.profile.length > 0 && c.profile.length <= 80)) fail(`certificates.${jobId}.profile`);
    hex(c.current, 64, `certificates.${jobId}.current`);
    if (!(Array.isArray(c.source) && c.source.length > 0 && Array.isArray(c.artifacts) && c.artifacts.length === c.source.length)) {
      fail(`certificates.${jobId} source/artifact counts`);
    }
    c.source.forEach((d, i) => { hex(d, 64, `certificates.${jobId}.source[${i}]`); if (d !== c.current) fail(`certificates.${jobId}.source[${i}] is not the current value`); });
    c.artifacts.forEach((a, i) => {
      identity(a, `certificates.${jobId}.artifacts[${i}]`);
      if (a.name !== certificateArtifactName(jobId, i, src.attempt) || a.run_id !== src.runId || a.head_sha !== src.headSha) {
        fail(`certificates.${jobId}.artifacts[${i}] is not entry ${i} of the source run and attempt`);
      }
      if (ids.has(a.id)) fail(`certificates.${jobId}.artifacts[${i}] repeats an artifact id`);
      ids.add(a.id);
    });
  }
  return coverage;
}

/** The certify job's ORIGINAL execution captured the current toolchain: exact steps, on macOS, successful. */
export function judgeCertifyCapture(job) {
  const where = `job ${job?.id} (${job?.name})`;
  refuse(job?.status === "completed" && job?.conclusion === "success",
    `${where} is ${job?.status}/${job?.conclusion}; a certified run's current toolchain capture must have succeeded`);
  refuse(JSON.stringify(job.labels ?? null) === JSON.stringify(["macos-15"]),
    `${where} captured on ${JSON.stringify(job.labels ?? null)}; the certify job runs on ["macos-15"]`);
  refuse(Array.isArray(job.steps), `${where} reports no step records`);
  for (const name of CERTIFY_STEPS) {
    const ran = job.steps.filter((step) => step?.name === name);
    refuse(ran.length === 1 && ran[0].status === "completed" && ran[0].conclusion === "success",
      `${where} did not execute "${name}" exactly once (${ran.map((st) => st?.conclusion).join(", ") || "absent"})`);
  }
}

/**
 * The witness's own clock, bound to the authenticated ORIGINAL executions: the
 * certify capture finished before the decision began (and not long before);
 * the witness was verified inside the decision step; its artifact was created
 * inside the keep step. Whole-second API stamps get `STEP_SKEW_MS` either side.
 */
export function judgeWitnessTiming({ certify, evidence, witness, art, maxAgeMs = CERTIFY_TO_VERIFIED_MAX_MS }) {
  refuse(Number.isSafeInteger(maxAgeMs) && maxAgeMs > 0 && maxAgeMs <= CERTIFY_TO_VERIFIED_MAX_MS,
    `a current-certificate age limit of ${maxAgeMs} ms is not F's canonical ${CERTIFY_TO_VERIFIED_MAX_MS} ms`);
  const step = (job, name) => job.steps.find((st) => st?.name === name);
  const window = (st, what) => {
    const from = Date.parse(st?.started_at);
    const to = Date.parse(st?.completed_at);
    refuse(Number.isFinite(from) && Number.isFinite(to) && from <= to, `${what} has no readable step window`);
    return [from - STEP_SKEW_MS, to + STEP_SKEW_MS];
  };
  const [decideFrom, decideTo] = window(step(evidence, CERTIFIED_EVIDENCE_STEPS[0]), "the evidence decision");
  const [keepFrom, keepTo] = window(step(evidence, CERTIFIED_EVIDENCE_STEPS[1]), "the witness keep step");
  const [captureFrom, captureTo] = window(step(certify, CERTIFY_STEPS[1]), "the certify capture");
  const handed = window(step(certify, CERTIFY_STEPS[2]), "the certificate handover")[1];
  refuse(handed <= decideFrom + 2 * STEP_SKEW_MS && captureTo <= decideFrom + 2 * STEP_SKEW_MS,
    "the certify capture did not finish before the evidence decision began");
  const verified = Date.parse(witness.verified_at);
  refuse(Number.isFinite(verified) && verified >= decideFrom && verified <= decideTo,
    `the witness says it was verified at ${witness.verified_at}, outside the decision step that produced it`);
  // F judged the current certificate's age at the moment it verified the
  // witness, not when the decision step began. The exact capture timestamp is
  // not retained, but the capture happened inside the certify step, so that
  // step's (skew-widened) START is the latest it can be assumed older than:
  // verified - start bounds the true age from above. Never widened beyond F.
  refuse(verified - captureFrom <= maxAgeMs,
    `the certify capture began more than ${maxAgeMs / 60_000} minutes before the witness was verified at `
    + `${witness.verified_at}; F accepts a current certificate at most that old`);
  const created = Date.parse(art.created_at);
  refuse(Number.isFinite(created) && created >= keepFrom && created <= keepTo,
    `witness artifact ${art.id} was created at ${art.created_at}, outside the step that kept it`);
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
    async download(path, { accept } = {}) {
      // `accept` exists for one caller: a release asset is its bytes only
      // under `application/octet-stream`; the default answers with metadata.
      const res = accept
        ? await fetchImpl(path.startsWith("https://") ? path : `${server}${path}`,
          { headers: { ...headers, Accept: accept }, redirect: "follow" })
        : await request(path);
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
  const { shape, blob } = await readProducerShape(api, { repository, sha });
  const coverage = coverageOf(jobs, shape);
  const roster = judgeProducerRoster(jobs, { runId: run.id, sha, latestAttempt: run.run_attempt, shape, coverage });
  return { workflow, run, jobs: roster.jobs, shape, workflowBlob: blob, auxiliaryJobs: roster.auxiliaryJobs, coverage };
}

/**
 * `macos.yml` AT THE IMMUTABLE COMMIT `sha` — the definition a push run of it,
 * or a `workflow_call` of it from that commit, executed — and its supported
 * shape. Shared by reuse selection and by the handoff verifier, so a historical
 * proof reads the same file through the same parser; it carries no age or
 * current-workflow-state rule. A missing or non-base64 answer is `Refused`, an
 * unsupported adoption `Unavailable`.
 */
export async function readProducerShape(api, { repository, sha }) {
  const file = await api.get(`/repos/${repository}/contents/${PRODUCER_WORKFLOW}?ref=${sha}`);
  refuse(file?.path === PRODUCER_WORKFLOW && file?.encoding === "base64" && typeof file?.content === "string",
    `the contents API did not return ${PRODUCER_WORKFLOW} at ${sha}`);
  const shape = workflowShape(Buffer.from(file.content, "base64").toString("utf8"));
  unavailable(shape !== "non-canonical",
    `${PRODUCER_WORKFLOW} at ${sha} carries a PR→main evidence adoption that is not the canonical one`);
  return { shape, blob: file.sha };
}

/**
 * The complete job roster of ONE attempt of `macos.yml` at `sha`, judged
 * against the immutable `shape`: every expected job exactly once, no unknown
 * job, the adoption auxiliaries all or none (as the shape says), every gate
 * job a completed success that EXECUTED its gate (`judgeExecution`). `prefix`
 * is the caller-job prefix a `workflow_call` renders (`"build / "` under
 * `macos-release.yml`); every listed job must carry it. `called` is that
 * workflow_call: it is not a push to main, so the adoption's `evidence` job
 * cannot have looked for, kept or handed on a witness — it must succeed with
 * its decision step and both handover steps NOT executed, and every gate job
 * still proves it executed in full.
 */
export function judgeProducerRoster(jobs, {
  runId, sha, latestAttempt, shape, prefix = "", called = false, coverage = COVERAGE_EXECUTED,
}) {
  refuse(coverage === COVERAGE_EXECUTED || (coverage === COVERAGE_CERTIFIED && !called && prefix === ""
    && (shape === ADOPTED_SHAPE || shape === EVENT_CONTRACT_SHAPE)),
  `coverage ${JSON.stringify(coverage)} is not supported for a ${called ? "called " : ""}${shape} run`);
  const expectedJobs = isAdopted(shape) ? [...AUXILIARY_JOBS, ...EXPECTED_JOBS] : EXPECTED_JOBS;
  const byExpected = new Map(expectedJobs.map((e) => [e.id, []]));
  const strays = [];
  for (const job of jobs) {
    refuse(job?.run_id === runId && job?.head_sha === sha,
      `job ${job?.id} listed under run ${runId} belongs to run ${job?.run_id} / ${job?.head_sha}`);
    // Every job's own attempt is a safe positive integer no later than the
    // run's latest. NOT equal to it: a "re-run failed jobs" attempt may list a
    // carried job with its original attempt or relabel it with the new one
    // (observed); the signed-build's origin is proved by `judgeExecutionOrigin`.
    // Without this, a job with no attempt makes `String(undefined)` the value a
    // forged provenance has to match.
    refuse(Number.isSafeInteger(job.run_attempt) && job.run_attempt >= 1 && job.run_attempt <= latestAttempt,
      `job ${job.id} (${job.name}) has run_attempt ${JSON.stringify(job.run_attempt)}; want an integer `
      + `from 1 to the run's latest attempt ${latestAttempt}`);
    const name = String(job.name ?? "");
    const expected = name.startsWith(prefix) ? expectedJobs.find((e) => e.match(name.slice(prefix.length))) : undefined;
    if (expected) byExpected.get(expected.id).push(job);
    else strays.push(job.name);
  }
  unavailable(strays.length === 0, `run ${runId} has unexpected jobs: ${strays.join(", ")}`);
  for (const [id, matched] of byExpected) {
    unavailable(matched.length === 1, `run ${runId} has ${matched.length} \`${id}\` job(s); want exactly one`);
    const job = matched[0];
    if (id === "screen" || id === "certify-macos") {
      // Auxiliary and never red; judged for presence and a final state only.
      unavailable(job.status === "completed" && AUXILIARY_CONCLUSIONS[id].includes(job.conclusion),
        `run ${runId}'s \`${id}\` job is ${job.status}/${job.conclusion}; want completed `
        + AUXILIARY_CONCLUSIONS[id].join("/"));
      continue;
    }
    // Certified: the run meant to be covered by its witness, so a mandatory
    // job that is known and contradicts its gate is `Refused` in auto and
    // reuse alike. A contract or signed-build still running is merely not yet
    // evidence (`Unavailable`); its absence is judged above.
    const certified = coverage === COVERAGE_CERTIFIED;
    const mandatory = id === "contract" || id === "signed-build";
    (certified && (CERTIFIABLE_JOBS.includes(id) || id === "evidence" || (mandatory && job.status === "completed"))
      ? refuse : unavailable)(
      job.status === "completed" && job.conclusion === "success",
      `run ${runId}'s \`${id}\` job is ${job.status}/${job.conclusion}; every gate job must succeed`);
    if (called && id === "evidence") {
      const where = `job ${job.id} (${job.name})`;
      unavailable(Array.isArray(job.steps) && job.steps.length > 0, `${where} reports no step records`);
      for (const step of [...REQUIRED_STEPS.evidence, ...MUST_NOT_RUN.evidence]) {
        const ran = job.steps.filter((s) => s?.name === step);
        unavailable(ran.every((s) => s.conclusion === "skipped"),
          `${where} ran "${step}" in a workflow_call; no witness can be kept outside a push to main`);
      }
      continue;
    }
    if (coverage === COVERAGE_CERTIFIED && CERTIFIABLE_JOBS.includes(id)) judgeWitnessed(id, job);
    else if (coverage === COVERAGE_CERTIFIED && id === "evidence") judgeCertifiedEvidence(job);
    else if (coverage === COVERAGE_CERTIFIED) judgeExecution(id, job, shape, { contradiction: refuse });
    else judgeExecution(id, job, shape);
  }
  return {
    coverage,
    jobs: EXPECTED_JOBS.map((e) => byExpected.get(e.id)[0]),
    auxiliaryJobs: isAdopted(shape) ? AUXILIARY_JOBS.map((e) => byExpected.get(e.id)[0]) : [],
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

// ── execution origin ────────────────────────────────────────────────────────

const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;
const instant = (value) => (typeof value === "string" && ISO_TIME.test(value) ? Date.parse(value) : NaN);

/**
 * What a job EXECUTED, independent of how a later attempt's inventory labels
 * it: run, commit, name, outcome, its own start and end, its runner labels,
 * and every step's number, name, outcome and times. GitHub relabels a job a
 * "re-run failed jobs" attempt carries — a new id, node id, created_at, URL,
 * runner_group_id and the NEW attempt number (observed on run 36943045523:
 * notarize-stage 110638815269 of attempt 1 is listed by attempt 5 as
 * 110694426825, run_attempt 5, with the same times and steps) — so none of
 * those is an execution key. The runner name, when both sides report one,
 * must also agree; it supplements the times and steps, never replaces them.
 */
export function executionIdentity(job, where) {
  refuse(job !== null && typeof job === "object", `${where} is not a job record`);
  refuse(Number.isSafeInteger(job.run_id) && typeof job.head_sha === "string" && SHA40.test(job.head_sha)
    && typeof job.name === "string" && job.name !== "", `${where} has no run, commit or name`);
  refuse(job.status === "completed" && job.conclusion === "success", `${where} is ${job.status}/${job.conclusion}, not a completed success`);
  const started = instant(job.started_at);
  const completed = instant(job.completed_at);
  refuse(Number.isFinite(started) && Number.isFinite(completed) && started <= completed,
    `${where} has no chronological start and end (${JSON.stringify(job.started_at)}..${JSON.stringify(job.completed_at)})`);
  refuse(Array.isArray(job.labels) && job.labels.every((l) => typeof l === "string" && l !== ""),
    `${where} has malformed runner labels`);
  refuse(Array.isArray(job.steps) && job.steps.length > 0, `${where} reports no step records`);
  let last = 0;
  const steps = job.steps.map((step) => {
    refuse(step !== null && typeof step === "object" && Number.isSafeInteger(step.number) && step.number > last
      && typeof step.name === "string" && step.name !== "" && typeof step.status === "string"
      && (step.conclusion === null || typeof step.conclusion === "string"),
    `${where} has a malformed, unordered or duplicate step record ${JSON.stringify(step?.number)}`);
    const times = [step.started_at, step.completed_at].map((t) => (t === null ? null : instant(t)));
    refuse(times.every((t) => t === null || Number.isFinite(t)) && (times.includes(null) || times[0] <= times[1]),
      `${where} step ${step.number} has unreadable or reversed times`);
    last = step.number;
    return [step.number, step.name, step.status, step.conclusion, step.started_at, step.completed_at];
  });
  return {
    key: JSON.stringify([job.run_id, job.head_sha, job.name, job.status, job.conclusion,
      job.started_at, job.completed_at, [...job.labels].sort(), steps]),
    runner: typeof job.runner_name === "string" && job.runner_name !== "" ? job.runner_name : null,
    started,
    completed,
  };
}

/**
 * The ORIGINAL execution of a job whose provenance names `originalAttempt`,
 * seen in a later attempt's complete inventory as `latestJob`. The provenance
 * attempt is the claim; it is proved only by reading that attempt itself —
 * its run record (same run, commit and workflow; completed, with ANY
 * conclusion, since a later job of that attempt may have failed) and its
 * complete job inventory, which must hold exactly one completed, successful
 * `jobName` labelled with that attempt — and by the latest attempt's job
 * being that same execution (`executionIdentity`). The latest wrapper may
 * keep the original attempt label or carry the latest one; any other label,
 * a different execution, or an unreadable original attempt is refused. An
 * original attempt equal to the latest needs no second read: the latest job
 * is the execution, labelled with that attempt.
 */
export async function judgeExecutionOrigin(api, { repository, runId, sha, workflowPath, jobName,
  originalAttempt, latestAttempt, latestJob }) {
  const where = `run ${runId} \`${jobName}\``;
  refuse(Number.isSafeInteger(latestAttempt) && latestAttempt >= 1, `${where}: the latest attempt is unknown`);
  refuse(Number.isSafeInteger(originalAttempt) && originalAttempt >= 1 && originalAttempt <= latestAttempt,
    `${where}: the provenance attempt ${JSON.stringify(originalAttempt)} is not an attempt from 1 to ${latestAttempt}`);
  refuse(latestJob?.run_id === runId && latestJob?.head_sha === sha && latestJob?.name === jobName,
    `${where}: the latest attempt's job is not this run's ${jobName} at ${sha}`);
  refuse(latestJob.run_attempt === latestAttempt || latestJob.run_attempt === originalAttempt,
    `${where} is labelled attempt ${JSON.stringify(latestJob.run_attempt)} in attempt ${latestAttempt}; `
    + `want ${latestAttempt} (relabelled) or the provenance attempt ${originalAttempt}`);
  const latest = executionIdentity(latestJob, `${where} (attempt ${latestAttempt} inventory)`);
  if (originalAttempt === latestAttempt) {
    return { attempt: originalAttempt, job: latestJob, identity: latest.key };
  }
  let record;
  let jobs;
  try {
    record = await api.get(`/repos/${repository}/actions/runs/${runId}/attempts/${originalAttempt}`);
    jobs = await paginate(api, `/repos/${repository}/actions/runs/${runId}/attempts/${originalAttempt}/jobs`, "jobs");
  } catch (error) {
    if (error instanceof Refused) throw error;
    throw new Refused(`${where}: attempt ${originalAttempt} could not be read (${error?.status ?? error?.message ?? "?"})`);
  }
  refuse(record?.id === runId && record?.run_attempt === originalAttempt && record?.head_sha === sha
    && workflowPathOf(record) === workflowPath && record?.status === "completed" && typeof record?.conclusion === "string",
  `${where}: attempt ${originalAttempt} is not a completed attempt of this run of ${workflowPath} at ${sha}`);
  for (const job of jobs) {
    refuse(job?.run_id === runId && job?.head_sha === sha,
      `${where}: attempt ${originalAttempt} lists job ${job?.id} of run ${job?.run_id} / ${job?.head_sha}`);
  }
  const hits = jobs.filter((job) => job.name === jobName);
  refuse(hits.length === 1, `${where}: attempt ${originalAttempt} lists ${hits.length} \`${jobName}\` job(s); want exactly one`);
  const original = hits[0];
  refuse(original.run_attempt === originalAttempt,
    `${where}: attempt ${originalAttempt} lists it as attempt ${JSON.stringify(original.run_attempt)}`);
  const first = executionIdentity(original, `${where} (attempt ${originalAttempt} inventory)`);
  refuse(first.key === latest.key && (first.runner === null || latest.runner === null || first.runner === latest.runner),
    `${where}: attempt ${latestAttempt} lists a different execution than attempt ${originalAttempt} ran `
    + "(its run, outcome, times, labels, runner or steps differ)");
  return { attempt: originalAttempt, job: original, identity: first.key };
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
export function entryKind(entry) {
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
export async function collectEvidence(api, { repository, repositoryId, sha, releaseVersion, now, dir, sourceGit }) {
  const { workflow, run, jobs, shape, workflowBlob, auxiliaryJobs, coverage } =
    await selectProducerRun(api, { repository, repositoryId, sha, now });
  // A certified run is re-authenticated in full BEFORE its artifact is read; an
  // executed run carries no certified chain at all.
  const certified = coverage === COVERAGE_CERTIFIED
    ? await judgeCertifiedCoverage(api, {
      repository, repositoryId, sha, run, now,
      rosterJobs: EXPECTED_JOBS.map((e, i) => ({ id: e.id, job: jobs[i] })),
      evidenceJob: auxiliaryJobs[AUXILIARY_JOBS.indexOf(EVIDENCE_JOB)],
      certifyJob: auxiliaryJobs[AUXILIARY_JOBS.indexOf(CERTIFY_JOB)],
      ...(sourceGit ? { sourceGit } : {}),
    })
    : null;
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
  // The provenance names the attempt signed-build ran in; that claim is read
  // from the authenticated bytes first and then PROVED against the run: a
  // "re-run failed jobs" attempt may relabel the carried job with its own
  // attempt, so the latest inventory's label is never the provenance attempt.
  const claimed = provenance !== null && typeof provenance === "object" && /^[1-9][0-9]*$/.test(provenance.runAttempt ?? "")
    ? Number(provenance.runAttempt) : NaN;
  const origin = await judgeExecutionOrigin(api, {
    repository, runId: run.id, sha, workflowPath: PRODUCER_WORKFLOW, jobName: "signed-build",
    originalAttempt: claimed, latestAttempt: run.run_attempt, latestJob: signedBuild,
  });
  // The certificate describes the tooling of the witness attempt; a signed
  // build executed in any other attempt ran on tooling nothing certified.
  refuse(certified === null || origin.attempt === certified.witness.attempt,
    `signed-build executed in attempt ${origin.attempt}, but the certified coverage is of attempt `
    + `${certified?.witness.attempt}; a re-executed signed build cannot inherit that coverage`);
  const { version, build } = judgeProvenance(
    provenance,
    hashes,
    files.get("Relayium.dmg.sha256").toString("utf8"),
    {
      repository,
      repositoryId,
      sha,
      runId: run.id,
      signedBuildAttempt: origin.attempt,
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
    jobs: [...jobs, ...auxiliaryJobs].map((job) => ({
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
    coverage: certified ?? { mode: COVERAGE_EXECUTED },
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
    signedBuildOrigin: evidence.signedBuildOrigin,
    artifact: { id: evidence.artifact.id, name: evidence.artifact.name, digest: evidence.artifact.digest },
    files: evidence.files,
    version: evidence.version,
    build: evidence.build,
    coverage: evidence.coverage,
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
