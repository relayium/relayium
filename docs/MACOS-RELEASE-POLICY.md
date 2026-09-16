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

## Recovery

Published tags and assets are immutable. If publication partially succeeds,
recover by rerunning the same version only when the existing release target and
asset bytes are identical. Otherwise publish a higher build and, when users
would receive different public bytes, an appropriate higher semantic version.
Never overwrite or retarget an existing public release.
