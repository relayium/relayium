#!/usr/bin/env bash
# Frozen-build downgrade probe for the protected Device Inbox root.
#
# Runs the ACTUAL Swift sources of the frozen macOS 1.4.3 (40) candidate
# (e96dc9e6c) — not a re-implementation — over a layout written by the current
# build, then checks with the current build that nothing it needs was lost.
#
# A mandatory LOCAL evidence gate for changes to the Device Inbox persistence
# boundary; deliberately not a hosted lane (it builds the whole package twice).
# The permanent guards are the unit tests in RelayiumKitTests.
#
# usage: scripts/ci/device-inbox-downgrade-probe.sh <evidence-dir>
set -euo pipefail

FROZEN=e96dc9e6c
repo=$(git rev-parse --show-toplevel)
evidence=${1:?usage: $0 <evidence-dir>}
mkdir -p "$evidence"
work=$(mktemp -d "${TMPDIR:-/tmp}/relayium-downgrade-probe.XXXXXX")
trap 'rm -rf "$work"' EXIT
fixture="$work/appsupport"
old="$work/frozen"
mkdir -p "$fixture" "$old"

git -C "$repo" cat-file -e "$FROZEN^{commit}"
git -C "$repo" archive "$FROZEN" apps/RelayiumKit | tar -x -C "$old"
cp "$repo/scripts/ci/fixtures/device-inbox-downgrade/OldBuildProbeTests.swift" \
   "$old/apps/RelayiumKit/Tests/RelayiumKitTests/OldBuildProbeTests.swift"

# RELAYIUM_DOWNGRADE_PROBE_CONTROL=shared-root is a harness negative control:
# the new build then leaves its marked delivery in the shared root and the
# FROZEN stage must fail.
run_new() {
  (cd "$repo/apps/RelayiumKit" &&
    RELAYIUM_DOWNGRADE_PROBE_DIR="$fixture" RELAYIUM_DOWNGRADE_PROBE_PHASE="$1" \
    swift test --filter 'RelayiumKitTests.DeviceInboxDowngradeProbeTests' 2>&1) | tee "$evidence/new-$1.log"
}

run_new produce
(cd "$old/apps/RelayiumKit" &&
  RELAYIUM_DOWNGRADE_PROBE_DIR="$fixture" \
  swift test --filter 'RelayiumKitTests.OldBuildProbeTests' 2>&1) | tee "$evidence/frozen-e96dc9e6c.log"
cp "$fixture/old-build-report.json" "$evidence/old-build-report.json"
run_new consume

for log in new-produce frozen-e96dc9e6c new-consume; do
  grep -Eq "Executed [1-9][0-9]* tests?, with 0 failures" "$evidence/$log.log" ||
    { echo "downgrade probe: $log did not pass" >&2; exit 1; }
  if grep -q " skipped " "$evidence/$log.log"; then
    echo "downgrade probe: $log skipped its case" >&2; exit 1
  fi
done
echo "downgrade probe: PASS (frozen $FROZEN left the protected root byte-identical)"
