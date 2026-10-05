# macOS release policy

This is the operating policy for Relayium's macOS release train. It applies to
the version after the already prepared **1.1 (build 2)** release; that release
keeps its existing `macos-v1.1` tag so a naming-only change does not invalidate
an accepted candidate.

## Public versions

Use three-part semantic versions: `MAJOR.MINOR.PATCH`.

- Increase `PATCH` for a compatible correction with no meaningful new user
  capability, for example `1.1.0` to `1.1.1`.
- Increase `MINOR` for a backward-compatible, user-visible capability, for
  example `1.1.1` to `1.2.0`.
- Increase `MAJOR` for an intentionally incompatible product or protocol
  boundary, for example `1.9.3` to `2.0.0`.

Do not use forms such as `1.01`, and do not change the public version for every
commit. The version describes what users receive, not how many development
iterations produced it.

Beginning with the release after 1.1, use the same three-part value for
`CFBundleShortVersionString`, the `release_version` input of
`.github/workflows/macos-release.yml`, Sparkle metadata, public download
metadata, and the immutable GitHub tag `macos-v<MAJOR.MINOR.PATCH>`.

## How a release is started

Dispatch **`.github/workflows/macos-release.yml`**. It is the only entry point
for macOS notarization, public-metadata staging and publication, and it is
manual-only: it has no `push` and no `pull_request` trigger.

`.github/workflows/macos.yml` is the CI half. It runs on every push to `main` and
every pull request, and it is **not** dispatchable — it has no manual trigger at
all. Do not look for the release inputs there; they moved.

The release workflow's five inputs are the ones that used to live on `macos.yml`,
unchanged in name, type, default and description:

| Input | Type | Default | What it does |
| --- | --- | --- | --- |
| `notarize` | boolean | `false` | submit the signed DMG to Apple, staple it, assess it |
| `validate_notary_credentials` | boolean | `false` | authenticate to Apple without submitting |
| `validate_sparkle_key` | boolean | `false` | prove the update key matches the app |
| `release_version` | string | `''` | stage immutable public-release metadata for this version |
| `publish_release` | boolean | `false` | publish the GitHub Release and deliver metadata to `main` |
| `metadata_delivery` | choice | `operator` | who performs the main fast-forward and release creation: `operator` hands off, `workflow` writes |
| `signed_build_source` | choice | `auto` | reuse proven exact-main signed build, or rebuild |

**With every input left at its default the workflow builds and stops.** Both
release stages require a dispatch *and* a non-default input, so a run started to
get a signed build cannot notarize or publish. That is asserted in
`scripts/test/ci-event-policy-test.mjs`, not merely intended.

### The CI / release boundary

The two workflows are one pipeline: `macos-release.yml`'s `build` job **calls**
`macos.yml` as a reusable workflow, so what gets notarized is built by the same
`signed-build` lane every pull request already runs. There is no second build
definition to keep in step.

The split is a permission and capability boundary, and it is enforced:

* `macos.yml` holds `contents: read` and no job-level permission block. It
  contains no notary key, no Sparkle private key, no `GITHUB_TOKEN`, no
  `gh release`, no `git push` and no `contents: write`. It cannot publish because
  it contains nothing that publishes.
* `macos-release.yml` holds `contents: read` at the top; its `publish` job is the
  only job in either workflow that declares `contents: write`.
* The call forwards exactly four secrets — the signing certificate, its password
  and the two provisioning profiles — one line each. It never uses
  `secrets: inherit`. The notary key and the Sparkle private key are referenced
  only inside `notarize-stage`.
* `notarize-stage` downloads the artifact **by the name the build reported**, and
  its first step fails if that name is empty. A skipped build contributes an empty
  output, so the guard is what turns "nothing was built" into a clear failure
  instead of a confusing missing-artifact error.

An operator does not need to interact with `macos.yml` for a release. If a
release needs something that only `macos.yml` can do, the change belongs in the
call's inputs — not in a manual trigger restored to the CI half.

## Processor architecture: Apple silicon only

Standing owner decision, 2026-09-16. Starting with **1.4.0**, every newly
produced Relayium macOS version is built for Apple silicon (`arm64`) only. This
is a rule for all future versions, not a one-release exception, and it covers
every channel: the Developer ID/GitHub download, Sparkle updates, TestFlight,
Mac App Store submissions and private owner-preview candidates. Do not produce
an Intel (`x86_64`) or universal package unless the owner explicitly reverses
the decision.

How it is enforced, and where:

* **Source.** `ARCHS = arm64` on the four product targets (direct app, direct
  Share extension, App Store app, App Store Share extension) in Debug and
  Release. `BundleVersionTests.testTheMacProductsAreAppleSiliconOnly` fails if a
  target reverts to the standard architectures. The UI test bundle keeps the
  default and builds for its host.
* **Built bytes.** `apps/mac/scripts/verify-apple-silicon.sh <Relayium.app>`
  requires the app's executable and every embedded extension's executable to be
  exactly `arm64`, and rejects a universal or Intel slice. It runs on the signed
  direct build and the App Store product in `macos.yml`, and on the mounted DMG
  in `macos-release.yml` before notarization. `test-verify-apple-silicon.sh`
  runs in the release-script tests. Vendor frameworks delivered prebuilt (Sparkle,
  WebRTC) stay universal; they are not stripped, and the arm64-only main
  executable is what makes the app unlaunchable on Intel.
* **Sparkle feed.** Sparkle 2.9.4 honours `<sparkle:hardwareRequirements>arm64`
  and never offers such an item to a native Intel process, and its
  `generate_appcast` writes the element for an arm64-only executable.
  `web/scripts/stage-macos-release.mjs` refuses a generated item without exactly
  that requirement, and refuses a generated feed with more than the one release
  item. The feed holds that single item; no earlier Intel-capable item is
  carried forward. The release workflow re-asserts the element and the item
  count on the staged and on the delivered feed.
* **Public metadata.** The stager writes `"architectures": ["arm64"]` into
  `web/native-releases.json`. The `/apps` card, the Device Inbox download link
  and the maintained `/apps` page twins state the Apple silicon requirement
  when, and only when, the manifest records it — never from a user-agent guess.
* **UI tests.** Hosted `macos-15` runners are Apple silicon; the UI smoke job
  fails, rather than skips, on any other host architecture.

Historical Intel-capable universal public releases (every public release before 1.4.0)
stay immutable and their records stay as written. There is no Intel update lane
and no legacy Intel migration or compatibility work: the owner confirmed there
are no existing users to migrate. Version policy is not architecture-aware — do
not add a cap that holds `minimumSupportedVersion` or `recommendedVersion` at a
last Intel-capable release. Raising the minimum supported version to 1.4.0 after
launch is the owner's separate decision; release preparation leaves the served
minimum unchanged.

## Build numbers

`CFBundleVersion` is an independent, strictly increasing integer. Increase it
for each signed candidate intended for owner review or public distribution.
Local builds and ordinary CI checks do not consume a build number. Never reuse
a build number for different shipped bytes, and never lower it in Sparkle.

The direct-download and Mac App Store targets currently share this build
setting, so treat the sequence as global across both channels. Uploading a build
to App Store Connect consumes that number even if the build is only used in
TestFlight or is later rejected. A corrected upload for the same public version
must use the next integer; it must not reuse the previous upload's number.

Examples:

| Purpose | Public version | Build |
| --- | --- | ---: |
| First public feature release | `1.2.0` | `3` |
| Rebuilt review candidate, same user release | `1.2.0` | `4` |
| Published bug fix | `1.2.1` | `5` |
| Next compatible feature release | `1.3.0` | `6` |

## Development cadence

Work in small, coherent, execution-verifiable batches. A batch should solve one
clear problem and include the product surface, behavior, tests, accessibility,
localization, and documentation needed to make that problem genuinely usable.
It should not mix unrelated navigation, protocol, release, and copy changes.

Before pushing a development batch:

1. run the focused tests for the changed behavior;
2. run the relevant source guards and build check;
3. reproduce any previously failing runtime scenario locally when the local
   environment supports it;
4. push only after those focused gates pass.

Feature-branch pushes may run affected UI-test shards for fast feedback. A
targeted or historical pass never substitutes for final release evidence.

## Publication gates

The exact commit used for a public release must pass all applicable macOS gates:

1. full Swift and release-script tests;
2. every macOS product-flow UI scenario, aggregated fail-closed across any
   parallel shards;
3. signed Release build and Sparkle component re-signing;
4. signature, entitlements, DMG contents, and checksum verification;
5. notarization, stapling, and Gatekeeper assessment;
6. Sparkle signature and strictly increasing build validation;
7. immutable GitHub Release creation and public metadata delivery;
8. installed/downloaded artifact and public update/download verification.

The final publication commit must pass the complete gate even when each changed
area passed a focused test earlier. Results from different commits must not be
combined to claim that one release commit passed.

For the Mac App Store channel, the corresponding publication gate is a signed
App Store archive and export, App Store Connect upload processing, internal
TestFlight purchase and restore validation against the production service, an
accepted App Review submission, and the owner's explicit manual release. The
Mac App Store build must not contain the direct channel's Sparkle updater.

## Platform boundary

macOS, iOS, CLI, and server versions are independent release trains. A macOS
release does not change the iOS version and does not compile, package, tag, or
publish iOS unless the owner explicitly authorizes a separate iOS task. A macOS
release dispatch starts `macos-release.yml` and the `macos.yml` lane it calls,
and nothing else: `ios.yml` is a separate file with its own path filter, so no
arrangement of jobs here can start it.

`docs/CI-PLATFORM-BOUNDARY.md` holds the repository-wide version of this rule,
including why the macOS CI and release halves are two files and what
`scripts/test/ci-event-policy-test.mjs` asserts about the seam.

## Metadata delivery: operator handoff (default) or workflow

The publish job always assembles, validates, claim-checks and freezes the
complete metadata candidate. What happens next depends on `metadata_delivery`.

**`operator` (default).** The job pushes only the unique candidate branch
`release-candidate/macos-v<version>-<run>-<attempt>`, dispatches
`merge-gate.yml` in `frozen-release-metadata` mode, identifies that exact run
(bounded; it does not wait for the gate's result), writes an immutable,
strictly versioned handoff record (`relayium-macos-publication-handoff/v2`,
uploaded as `relayium-macos-handoff-<sha>-<version>-attempt-<n>`) and a step
summary headed **HANDED OFF / NOT PUBLISHED**. It never pushes `main` and never
creates a release. **A green run in this mode is a staged handoff, not a
release.** When `main` already carries the metadata the candidate is empty; the
same validators still run and the record says `already-delivered`.

Why: for 1.4.5 (42) the job's own push to `main` was refused with GH006 after a
full green gate, and a later `gh release create` returned 403 and was recovered
by an existing administrator. The GH006 cause is **unknown** and is not asserted
here. The preflight can only prove the read-only contract; it cannot prove the
token may push or create a release without doing so.

The authorized operator then, from a checkout that has fetched current `main`,
the candidate branch, the source commit and that commit's first parent (a
full clone; a shallow clone without the parent is refused for a certified
chain), with the handoff record and the
artifact downloaded (`gh run download <run> -n relayium-macos-<sha>-<version>`),
using their existing `gh` login (no new token, no forced push, no forged
status). The verifier is a Node process and reads `GH_TOKEN` from its
environment, so a bare `GH_TOKEN="$(gh auth token)"` line on its own does not
reach it: prefix each invocation as shown below (or `export` the variable once
in that shell). Do not echo the variable or run with shell tracing (`set -x`).

Which steps apply depends on the record's `candidate.state`:

- `frozen`: step 1 (`--stage main`), step 2 (ordinary fast-forward), step 3
  (`--stage release`), step 4 (create, then rerun step 3).
- `already-delivered`: skip steps 1 and 2 entirely — there is nothing to
  fast-forward, and `--stage main` refuses this state. Start at step 3, then
  step 4. Only the supported delivered gate described under step 3 is accepted;
  the unsupported legacy-gate state keeps its manual same-artifact fallback.

Every `verify` accepts an optional `--archive <zip>`: the complete artifact
ZIP the operator already holds (for example the complete ZIP saved from a
download of that artifact; `verify` itself reads the bytes in memory and writes
nothing), used instead of downloading it again. It is a transfer
saving only: each run still requires those bytes to hash to the digest the API
reports for the record's artifact id at that moment, and every other check
(current run, artifact metadata and expiry, provenance, gate, `main`) runs
unchanged. Reuse one saved ZIP across steps 1, 3 and the step-4 readback.

1. `GH_TOKEN="$(gh auth token)" node scripts/release/macos-handoff.mjs verify --stage main --record handoff.json --artifact-dir <artifact> [--archive <zip>]` —
   read-only. The verifier downloads the artifact ZIP itself by the record's
   artifact id and requires its bytes to hash to the digest the API reports
   for that id (`--archive <zip>` instead verifies a ZIP the operator already
   holds against that same API digest; the record never authenticates archive
   contents). It reads the ZIP's entries in memory with the strict reader the
   reuse path uses (safe names, no duplicates, regular files, CRC, exact
   eight-file set), judges the notarized provenance's exact schema against the
   publisher run (`notarizedBy` run/attempt, source commit, version/build,
   arm64, Developer ID team, build or reuse origin), requires the artifact to
   have been created during that run's successful `notarize-stage` job and the
   run to have completed successfully at its recorded attempt, and requires
   every local file in `<artifact>` to equal the authenticated ZIP entry byte
   for byte. A reused signed build is judged at its producer run's latest
   attempt: that attempt's record and complete job inventory (each expected
   `macos.yml` job exactly once and green, the evidence-adoption jobs all or
   none). The attempt a build or notarization ran in is read from the
   authenticated provenance (`runAttempt`, `notarizedBy.runAttempt`), never
   from the latest inventory's label: GitHub lists a job carried into a
   "re-run failed jobs" attempt with that NEW attempt's number, a new job id,
   node id and `created_at` (observed on publisher run 36943045523: its
   attempt-1 `notarize-stage` is listed by attempt 5 as attempt 5 under a new
   id, with identical times and steps). The claimed attempt is proved by
   reading that attempt itself — its run record (same run, commit and
   workflow, completed with any conclusion, since a later job of it may have
   failed) and its complete job inventory, holding exactly one successful job
   of that name — and by the latest attempt's job being the SAME execution:
   run, commit, name, outcome, its own start and end, runner labels and every
   step's number, name, outcome and times (and the runner name when both
   report one). Wrapper id, node id, `created_at`, URL and runner group are
   not execution keys; a relabelled or label-retaining wrapper is accepted, a
   job that ran again is not the build or notarization the provenance
   describes. The artifact must have been created inside the ORIGINAL
   `notarize-stage` window. This applies to the reused producer's
   `signed-build`, this run's `build / signed-build`, the publisher's
   `notarize-stage`, and to a new reuse decision (`macos-evidence`). The
   signed producer itself is proved at the IMMUTABLE source commit for both a
   reuse and a fresh build, through the same helpers reuse selection uses:
   `macos.yml` is read from the contents API at the source SHA and must be a
   supported shape (`workflowShape`: legacy, or one of the canonical adoptions
   whole); the attempt's complete roster must be exactly that shape's jobs —
   the five gate jobs each once and successful, the adoption auxiliaries all
   present (screen and certify completed, evidence successful) or all absent,
   nothing unknown, nothing twice — and every gate job must have EXECUTED its
   required steps on its required runner, with no witness or foreign step run
   (`judgeExecution`). A fresh build is the run's own `workflow_call`: every
   job carries `build / `, and its `evidence` job, outside a push to main, must
   not have run its decision or handover steps. An unreadable or unsupported
   source workflow, or any roster or step gap, is a refusal. Verify applies NO
   freshness bound and no current-workflow-state rule: those decide whether a
   NEW release may reuse a build, not whether an old handoff was proved.
   Supported boundary: only the shapes `workflowShape` knows; a legacy shape is
   accepted on the same five-job roster and step rules, not on its text alone.
   **The signed-build chain (record v2).** A v2 record freezes `signedBuild`:
   its kind (`publisher-build`, this run's own `build / ` call, always executed
   coverage; or `main-push`, a reused `macos.yml` push run), the producer run,
   the signed build's ORIGINAL attempt and execution hash, the producer
   workflow shape and the coverage. For a reuse, emit does not select anything:
   it reads the publisher preflight's own decision artifact
   (`relayium-macos-build-source-<sha>-attempt-<n>`, the only one in the run)
   by its listing and record (the complete ten-field artifact identity, which
   must agree and be unexpired now), checks its bytes against the API digest,
   parses the single strict `reuse-decision.json` and requires its evidence to
   name exactly the producer run, signed-build attempt, payload hashes,
   version, build and toolchain the notarized provenance names. The latest
   preflight must be the ORIGINAL execution of that attempt's preflight; the
   decision was made inside its "Select the signed-build source" step and the
   artifact created inside the later "Upload the signed-build source decision"
   step (whole-second API stamps, 2 s tolerance). The decision's identity,
   attempt, preflight execution, time and mode are frozen in the record. A
   decision written before the evidence carried `signedBuildOrigin` and
   `coverage` (the 1.4.5 preflight's) is refused; its coverage is never
   inferred. A second decision artifact (a re-executed preflight) is refused,
   not resolved. The producer is then re-judged at its latest attempt with the
   DECISION's coverage (`coverageOf` must agree), its signed build must be the
   frozen original execution, and a `certified-full-proof` coverage is
   re-authenticated by the shared library reader
   `verifyHistoricalCertifiedCoverage` with the frozen coverage required, an
   explicit Git adapter bound to the operator's checkout (inherited `GIT_*`
   paths ignored) and the machine clock read fresh for each check; the
   certified witness attempt must be the signed build's original attempt. The
   two original source-age gates are judged at the witness's own
   `verified_at`, so a chain whose source is now older than 48 hours still
   verifies, while every artifact must be unexpired NOW. Verify re-derives the
   whole chain at its start and again at its end and requires both to equal
   the frozen `signedBuild` byte for byte (a replaced decision or certificate
   with equal bytes under a new id is a different chain). A v1 record is still
   parsed and verified exactly as before — executed-only — and is never read
   as certified. The step summary and `verify` print **verifiable until**: the
   earliest expiry among the notarized artifact, the decision and every
   certified-chain artifact. After it, `verify` refuses and the record proves
   nothing more; publication then needs the documented manual same-artifact
   fallback, never a claim that the handoff still verifies.
   The reused ORIGINAL pre-notarization signed ZIP is not part of that set.
   `signedBuild.signedArtifact` (its id, name and digest) is attested by the
   authenticated original decision, which named it when the build was
   selected; a historical `verify` does not download or re-read that ZIP, so
   its later expiry or deletion alone does not invalidate the handoff. What
   must stay authentic and unexpired is the CURRENT required chain — the
   notarized artifact, the decision and, for certified coverage, the witness,
   proof and source certificates — compared exactly against the machine clock
   at the start and again at the final re-read. This is not a waiver for new
   work: a new build selection, a new reuse and the reuse readback still
   refuse an expired or unavailable original signed input.
   Then: candidate and base commits must be the server's (tree and
   parents), the candidate one commit on the recorded base with exactly the
   recorded paths; scope is judged by the **base commit's** own
   `web/scripts/macos-release-candidate.mjs`, and the gate by the base's
   `scripts/ci/select-lanes.mjs` and workflow filters, both unpacked from Git
   objects into a private directory — never the candidate's or the invoking
   checkout's copy. The gate run must still be at its recorded attempt and
   every job green, and its job list must be exactly the roster BASE defines
   for a `workflow_dispatch` gate: `select` and `merge-gate`; for every lane
   the base selector requires (and the unconditional `compat` and
   `repo-hygiene`), every job of the called workflow under its real name —
   matrix and templated jobs (`macos / ui-smoke (…)` shards, `go / race
   account shard 0…7`) expanded to the exact names in the base's
   `scripts/ci/ci-evidence-registry.json` — present exactly once and
   successful; main-only auxiliaries (`screen`, `certify-*`) skipped or absent;
   the `evidence` job successful or skipped; every unselected lane present
   once as a skipped caller; nothing else and nothing twice. Job predicates
   are matched against a closed table (`DISPATCH_PREDICATES`); the web lane's
   scope-gated jobs are required because the base's own
   `web-lane-scope.mjs` runs everything for a dispatched gate. An unknown
   predicate, a lane job the registry does not name, or a caller this table
   does not understand is refused, never assumed. No native input (anything under `apps/` except
   `apps/README.md`) may differ between the notarized source and the
   candidate; `main == base` and the branch `== head`, read at the start and
   again at the end.
2. `git push origin <head>:main` — an ordinary fast-forward. If it succeeds only
   because of an existing administrator rule bypass, record that explicitly; it
   is **not** protected-check recognition.
3. `GH_TOKEN="$(gh auth token)" node scripts/release/macos-handoff.mjs verify --stage release --record handoff.json --artifact-dir <artifact> [--archive <zip>]` —
   everything above again, and `main` must now be **exactly** the candidate
   head. For an already-delivered record `main` must be exactly the `main` the
   record found; the delivering commit is the last first-parent commit on it
   that changed any of the five derived files (later docs-only commits are
   allowed), a one-parent commit whose change set its parent's (the original
   base's) scope checker accepts and whose derived files are the artifact's.
   Its green GitHub Actions `merge-gate` check run is only a pointer: the run
   its `details_url` names is read and cross-bound (same check suite, the
   run's latest attempt lists the aggregate job whose id is that check run,
   `merge-gate.yml`, `workflow_dispatch`, this repository, the delivering
   commit, a frozen `release-candidate/macos-v<this version>-…` branch or an
   internal full-candidate branch), then judged exactly like a frozen
   candidate's gate. A delivery proven only by another kind of run (a pull
   request merge, a full bootstrap) is an unsupported legacy-gate state and is
   REFUSED. A fresh frozen candidate is NOT a fallback there: the derived bytes
   already on `main` make the candidate empty again. Do not cut a new version
   or rebuild to manufacture one. The supported recovery is manual and
   same-artifact: an existing authorized operator reviews the authenticated
   artifact (digest, provenance, notarization execution), compares the three
   release assets byte for byte with it, and creates the release with
   `--target <source sha>` and `--latest=false`, recording that `verify` did
   not accept the delivery. The release list is read
   completely twice (drafts included) and must agree with itself and with the
   tag lookup; the tag must be absent or resolve to the notarized source; an
   existing release must be public, non-draft, non-prerelease, carry the exact
   title, notes and three assets — each downloaded by its asset id and
   byte-compared with the authenticated artifact — and must not hold the
   `latest` alias.
4. `gh release create` with exactly the record's `releasePlan` (title, notes,
   `--target <source sha>`, `--latest=false`) and exactly these three uploads
   from `<artifact>`, matching the workflow's own publish step:
   `<artifact>/Relayium.dmg`, `<artifact>/Relayium.dmg.sha256` and
   `<artifact>/release-web/public/apps/macos/appcast.xml#appcast.xml` (the feed
   is nested in the artifact, not at its root; `#appcast.xml` names the asset).
   Then rerun step 3 (with the same `--archive <zip>` if used), which now reads
   the release back.

The record's release notes must be exactly the publisher run's canonical notes;
any other text is refused, so a record cannot carry instructions.

After the slow downloads and the release readback the verifier re-reads the
mutable state it judged — the publisher run and its jobs, the artifact record
(expiry against the machine's clock at that moment), the gate run and the
reused producer run — and `main` and the candidate branch, and refuses on any
change. The verifier takes no clock override: expiry is judged against the
machine's time. It cannot close the race between its last read and the
operator's write; a non-forced push is what loses that race.

**Recovery without a rebuild.** The verifier requires the publisher run to
have completed successfully, including its `publish` job: a failed publication
is never reported as a successful one, and a handoff from a failed run is not
verifiable. That does not remove the original no-rebuild recovery. If the
`publish` job fails (before or after the record is written), re-run only that
failed job: the new attempt reuses the already-notarized artifact (the
`notarize-stage` job and its upload are carried; nothing is rebuilt or
re-notarized), pushes a new candidate branch named for the new attempt and
writes a new record, and the old record is refused because the run is no longer
at its attempt. The new attempt's emit and `verify` accept the carried
notarization whether GitHub relabels its job with the new attempt or keeps the
original label, after proving it against the original attempt as above; the
original attempt's failed publication stays a failure, and a green handoff is
still HANDED OFF / NOT PUBLISHED. A historical publisher run that never
succeeded, or a release already public before any successful handoff, remains a
documented manual fallback (above), never a successful handoff. Failures after a successful handoff happen in the operator's
own steps and need no re-run: fix the cause and run `verify` again; the record
stays usable only through its **verifiable until**, the earliest expiry of the
whole chain `verify` must re-read (above), while the original signed input keeps
its attested, not-re-read historical meaning. The notarization proof
(the authenticated artifact, its `notarize-stage` job and provenance) is
judged separately from the publication status and is never the same claim. In
`workflow` mode the existing recovery is unchanged.

The verifier writes nothing. Its verdict is evidence for review, not a write.

**`workflow`.** The prior automatic delivery, unchanged: watch the gate, verify
it as a record, fast-forward `main`, read it back, create the release with
`--latest=false` and read the alias back. The preflight refuses this mode before
the paid build when the source commit's `.github/workflows` tree differs from
`main`'s — a documented condition under which a `GITHUB_TOKEN` write may be
refused (the 1.4.5 403 occurred in that state). The comparison uses authentic
Git tree reads and fails closed on truncated or unreadable data. In `operator`
mode a mismatch is reported, not refused. A matching tree does **not** prove
the token may push.

An unknown or missing `metadata_delivery` fails the preflight and the publish
job before any write.

## Recovery

Published tags and assets are immutable. If publication partially succeeds,
recover by rerunning the same version only when the existing release target and
asset bytes are identical. Otherwise publish a higher build and, when users
would receive different public bytes, an appropriate higher semantic version.
Never overwrite or retarget an existing public release.
