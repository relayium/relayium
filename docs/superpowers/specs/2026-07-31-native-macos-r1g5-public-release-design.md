# Native macOS R1-G5 — controlled public release design

## Outcome

Promote an already signed, universal, notarized Relayium disk image into one
coherent public release:

1. an immutable, versioned GitHub Release contains the stapled `Relayium.dmg`;
2. the Sparkle feed signs that exact final disk image and points at that exact
   release asset;
3. `/apps` changes its macOS card from a disabled placeholder to the same
   versioned download;
4. production deploys the feed and download surface from a traceable `main`
   commit.

The normal macOS CI path remains non-publishing. Publication requires an
explicit manual input and the existing signing, Sparkle, and Apple
notarization credentials.

## Why this is a separate promotion step

Apple accepting a submission proves neither that the top-level DMG passes
Gatekeeper nor that Sparkle signed the stapled bytes. Likewise, publishing a
GitHub asset alone does not make the updater or website usable. Treating those
events as one release transaction prevents three independently plausible but
incomplete "released" states.

## Canonical release state

`web/native-releases.json` is the small, public, non-secret manifest consumed
by the SPA and release tests. Before the first release it records:

```json
{
  "macos": {
    "available": false,
    "version": null,
    "build": null,
    "downloadUrl": null
  }
}
```

The release workflow changes all four fields together only after generating a
real signed appcast (and records a strictly increasing numeric build). The
download URL is immutable and versioned:

```text
https://github.com/relayium/relayium/releases/download/macos-v<VERSION>/Relayium.dmg
```

Do not use GitHub's `/releases/latest/` alias: Relayium's CLI/server and macOS
client have different release trains, so "latest" can resolve to an unrelated
release without a DMG.

## Workflow

The existing manual `macos` workflow gains two inputs:

- `release_version`: stage public-release metadata for the signed build;
- `publish_release`: perform the external writes after every gate passes.

`publish_release=true` is rejected unless notarization is also enabled, the
workflow runs from `main`, and `release_version` exactly matches the built
app's `CFBundleShortVersionString`.

The signed-build job:

1. builds and signs the universal app;
2. signs the DMG container;
3. submits it to Apple, staples the accepted ticket, and runs Gatekeeper;
4. generates the Sparkle appcast **after stapling**, so its EdDSA signature
   covers the shipped bytes;
5. validates and stages `appcast.xml` plus `native-releases.json`;
6. uploads the DMG, checksum, appcast, manifest, and notarization evidence.

The publish job has the only `contents: write` permission. It:

1. downloads the just-produced artifacts;
2. revalidates their checksum and metadata;
3. creates the immutable `macos-v<VERSION>` GitHub Release targeted at the
   workflow commit (or accepts an identical existing release on recovery);
4. updates the two canonical web release files on the latest `main` only when
   the workflow commit is still an ancestor;
5. runs the full web gates, commits, and pushes that metadata;
6. leaves production deployment to the existing five-minute atomic deploy,
   whose deployed SHA and public surfaces are verified separately.

Publishing the release asset before the web metadata is the safe partial order:
a recoverable failure can leave an undiscoverable GitHub release, but the live
website and updater never point at a missing file.

## UI and copy

The English SPA reads the manifest at build time:

- unavailable: dimmed card, "Coming soon", disabled button;
- available: normal card, "Available", localized download link.

Existing platform descriptions become release-state-neutral. iOS remains
explicitly upcoming. Static localized `/apps` prose must not claim that macOS
is still coming soon after the manifest flips; focused tests cover both the
source manifest and generated/crawler surfaces.

## Recovery and rollback

- A failed build/notarization/signature check performs no public write.
- A release tag collision with different bytes or a different commit is a hard
  failure; assets are never overwritten in place.
- If GitHub publication succeeds but the metadata commit fails, rerun the same
  workflow. It accepts only an identical existing release and retries the
  metadata delivery.
- If the public app must be withdrawn, set `available=false` and restore the
  inert appcast in a normal reviewed commit. Do not mutate or reuse the release
  tag; publish a higher build/version for a corrected binary.

## Non-goals

- automatic scheduled macOS releases;
- moving or mutable "latest" tags;
- sharing the CLI/server `v*` release train;
- starting iOS distribution;
- weakening any signing, notarization, Gatekeeper, or Sparkle gate.
