#!/bin/bash

set -Eeuo pipefail

script_dir="$(cd "$(dirname "$0")" && pwd -P)"
repo_root="$(cd "$script_dir/../../.." && pwd -P)"
checker="$script_dir/check-release-readiness.mjs"
readiness="$repo_root/apps/mac/release-readiness.json"
work_dir="$(mktemp -d "${TMPDIR:-/tmp}/relayium-release-readiness.XXXXXX")"
trap 'rm -rf "$work_dir"' EXIT INT TERM

node "$checker" "$readiness"

# The manifest is hand-maintained, so a shipped capability can silently keep
# claiming it is missing and go on blocking the release gate. Ephemeral realtime
# text did exactly that. Assert the manifest against the artifacts its evidence
# names: while these exist, the capability cannot be marked unimplemented.
text_sources=(
  "$repo_root/apps/RelayiumKit/Sources/RelayiumAppKit/RealtimeTextSessionModel.swift"
  "$repo_root/apps/RelayiumKit/Sources/RelayiumKit/RealtimeWire/RealtimeTextFrame.swift"
  "$repo_root/apps/RelayiumKit/Tests/RelayiumKitTests/RealtimeTextSessionModelTests.swift"
  "$repo_root/apps/RelayiumKit/Tests/RelayiumKitTests/RealtimeTextFrameTests.swift"
  "$repo_root/apps/mac/Relayium/RealtimeTextPane.swift"
)
for source_path in "${text_sources[@]}"; do
  if [ ! -f "$source_path" ]; then
    # Either the feature was removed — then the manifest evidence is stale too —
    # or a rename left this list pointing at nothing. Both need a human.
    echo "error: ephemeral-text evidence source is missing: $source_path" >&2
    exit 1
  fi
done

read_capability() {
  # JavaScript template literals must remain single-quoted from the shell.
  # shellcheck disable=SC2016
  node -e '
    const fs = require("fs");
    const value = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    const item = value.capabilities.find((entry) => entry.id === process.argv[2]);
    if (!item) {
      process.stderr.write(`missing capability: ${process.argv[2]}\n`);
      process.exit(1);
    }
    process.stdout.write(String(item[process.argv[3]]));
  ' "$1" "$2" "$3"
}

read_approval() {
  node -e '
    const fs = require("fs");
    const value = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    process.stdout.write(String(value.approved));
  ' "$1"
}

if [ "$(read_capability "$readiness" ephemeral-text implemented)" != true ]; then
  echo "error: ephemeral-text is implemented in the app but the manifest says otherwise" >&2
  exit 1
fi

if [ "$(read_approval "$readiness")" = true ]; then
  node "$checker" --require-approved "$readiness"
else
  if node "$checker" --require-approved "$readiness" \
    >"$work_dir/unapproved.stdout" 2>"$work_dir/unapproved.stderr"; then
    echo "error: current unapproved release was accepted" >&2
    exit 1
  fi
  grep -Fq "macOS release is not approved" "$work_dir/unapproved.stderr"
fi

approved="$work_dir/approved.json"
node -e '
  const fs = require("fs");
  const value = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  value.approved = true;
  for (const item of value.capabilities) item.implemented = true;
  fs.writeFileSync(process.argv[2], JSON.stringify(value));
' "$readiness" "$approved"
node "$checker" --require-approved "$approved"

# Keep the blocker invariant independent of the live manifest's progress.
# Exactly one required capability is unimplemented, and approval must be
# refused both with and without --require-approved.
single_blocker="$work_dir/single-blocker.json"
node -e '
  const fs = require("fs");
  const value = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  const target = value.capabilities.find((item) => item.required);
  if (!target) {
    process.stderr.write("fixture needs at least one required capability\n");
    process.exit(1);
  }
  target.implemented = false;
  fs.writeFileSync(process.argv[2], JSON.stringify(value));
' "$approved" "$single_blocker"
if node "$checker" --require-approved "$single_blocker" \
  >"$work_dir/single-blocker.stdout" 2>"$work_dir/single-blocker.stderr"; then
  echo "error: release with one unimplemented required capability was approved" >&2
  exit 1
fi
grep -Fq "approved release still has blockers" "$work_dir/single-blocker.stderr"

if node "$checker" "$single_blocker" \
  >"$work_dir/single-blocker-no-flag.stdout" \
  2>"$work_dir/single-blocker-no-flag.stderr"; then
  echo "error: approved release with one blocker was accepted without the approval flag" >&2
  exit 1
fi
grep -Fq "approved release still has blockers" "$work_dir/single-blocker-no-flag.stderr"

echo "release-readiness tests passed"
