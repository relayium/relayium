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
`CFBundleShortVersionString`, the workflow's `release_version`, Sparkle metadata,
public download metadata, and the immutable GitHub tag
`macos-v<MAJOR.MINOR.PATCH>`.

## Build numbers

`CFBundleVersion` is an independent, strictly increasing integer. Increase it
for each signed candidate intended for owner review or public distribution.
Local builds and ordinary CI checks do not consume a build number. Never reuse
a build number for different shipped bytes, and never lower it in Sparkle.

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

## Platform boundary

macOS, iOS, CLI, and server versions are independent release trains. A macOS
release does not change the iOS version and does not compile, package, tag, or
publish iOS unless the owner explicitly authorizes a separate iOS task. Manual
macOS publication keeps the iOS job skipped.

## Recovery

Published tags and assets are immutable. If publication partially succeeds,
recover by rerunning the same version only when the existing release target and
asset bytes are identical. Otherwise publish a higher build and, when users
would receive different public bytes, an appropriate higher semantic version.
Never overwrite or retarget an existing public release.
