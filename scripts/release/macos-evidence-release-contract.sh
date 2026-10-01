#!/usr/bin/env bash
# scripts/release/macos-evidence-release-contract.sh — the release contract,
# judged on the notarization runner against the package about to be notarized.
#
#   RELEASE_VERSION=… NOTARIZE=… PUBLISH_RELEASE=… \
#     macos-evidence-release-contract.sh <provenance.json>
#
# `macos.yml`'s `contract` job is the same contract for a release that builds.
# A release that REUSES an exact-main build skips that whole call, so the
# contract runs here on both sources: the release-input shape, the notarize
# intent, the Apple project's actual MARKETING_VERSION and
# CURRENT_PROJECT_VERSION against the package's version and build, and for a
# publication `main` plus approved readiness. Nothing here is relaxed relative
# to the `contract` job; the project-build equality is new and strictly adds.
set -euo pipefail

provenance="${1:?usage: macos-evidence-release-contract.sh <provenance.json>}"
release_version="${RELEASE_VERSION:-}"
notarize="${NOTARIZE:-false}"
publish="${PUBLISH_RELEASE:-false}"

fail() { echo "::error::$*" >&2; exit 1; }

if [ "$publish" = true ]; then
  [ -n "$release_version" ] || fail "publish_release requires release_version"
  [ "${GITHUB_REF:-}" = refs/heads/main ] || fail "publish_release must run from main, not ${GITHUB_REF:-unset}"
fi

if [ -n "$release_version" ]; then
  printf '%s' "$release_version" | grep -Eq '^[0-9]+(\.[0-9]+){1,2}$' \
    || fail "release_version $release_version is not a version"
  [ "$notarize" = true ] || fail "release_version $release_version requires notarize=true"
  settings="$(xcodebuild -project apps/mac/Relayium.xcodeproj -scheme Relayium \
    -configuration Release -showBuildSettings)"
  marketing="$(printf '%s\n' "$settings" | awk '/^ *MARKETING_VERSION =/{print $3; exit}')"
  project_build="$(printf '%s\n' "$settings" | awk '/^ *CURRENT_PROJECT_VERSION =/{print $3; exit}')"
  [ "$marketing" = "$release_version" ] \
    || fail "release $release_version != MARKETING_VERSION $marketing"
  [ "$(jq -r .version "$provenance")" = "$marketing" ] \
    || fail "the package is version $(jq -r .version "$provenance"), the project $marketing"
  [ -n "$project_build" ] && [ "$(jq -r .build "$provenance")" = "$project_build" ] \
    || fail "the package is build $(jq -r .build "$provenance"), the project ${project_build:-unset}"
fi

if [ "$publish" = true ]; then
  node apps/mac/scripts/check-release-readiness.mjs --require-approved
fi

echo "release contract holds (version ${release_version:-none}, notarize $notarize, publish $publish)"
