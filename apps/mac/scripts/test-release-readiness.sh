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

# Same guard for account device/stored-file management, and for the same reason:
# the manifest now claims it, so the artifacts that claim rests on must exist.
account_sources=(
  "$repo_root/apps/RelayiumKit/Sources/RelayiumAppKit/AccountManagementModel.swift"
  "$repo_root/apps/RelayiumKit/Sources/RelayiumKit/Account/StoredLinkKeyStore.swift"
  "$repo_root/apps/RelayiumKit/Tests/RelayiumKitTests/AccountManagementModelTests.swift"
  "$repo_root/apps/RelayiumKit/Tests/RelayiumKitTests/AccountManagementClientTests.swift"
  "$repo_root/apps/RelayiumKit/Tests/RelayiumKitTests/StoredLinkKeyStoreTests.swift"
  "$repo_root/server/account/devices_bearer_test.go"
  "$repo_root/apps/mac/Relayium/AccountView.swift"
  "$repo_root/apps/RelayiumKit/Sources/RelayiumKit/Account/AccountClient.swift"
  "$repo_root/apps/RelayiumKit/Sources/RelayiumKit/Account/AccountModels.swift"
  "$repo_root/apps/RelayiumKit/Sources/RelayiumAppKit/CloudUploadModel.swift"
  "$repo_root/apps/RelayiumKit/Sources/RelayiumAppKit/UploadPresentation.swift"
  "$repo_root/apps/RelayiumKit/Sources/RelayiumAppKit/ErrorCopy.swift"
  "$repo_root/apps/RelayiumKit/Tests/RelayiumKitTests/CloudUploadModelTests.swift"
  "$repo_root/apps/RelayiumKit/Tests/RelayiumKitTests/ErrorCopyTests.swift"
  "$repo_root/apps/RelayiumKit/Tests/RelayiumKitTests/Support/LoginWordingAssertion.swift"
  "$repo_root/server/account/auth.go"
  "$repo_root/server/account/handlers.go"
)
for source_path in "${account_sources[@]}"; do
  if [ ! -f "$source_path" ]; then
    echo "error: account-management evidence source is missing: $source_path" >&2
    exit 1
  fi
done

# Localization. Same reasoning again, with one addition: the catalogs are DATA,
# so a rename or a bad merge can delete eight of them and leave a build that
# compiles, runs, and silently renders English to everybody.
localization_sources=(
  "$repo_root/apps/RelayiumKit/Sources/RelayiumAppKit/Localization/AppLanguage.swift"
  "$repo_root/apps/RelayiumKit/Sources/RelayiumAppKit/Localization/L10n.swift"
  "$repo_root/apps/RelayiumKit/Sources/RelayiumAppKit/Localization/L10nKey.swift"
  "$repo_root/apps/RelayiumKit/Sources/RelayiumAppKit/Localization/LocalizationCatalog.swift"
  "$repo_root/apps/RelayiumKit/Sources/RelayiumAppKit/Localization/PluralRule.swift"
  "$repo_root/apps/RelayiumKit/Sources/RelayiumAppKit/Localization/AppCopy.swift"
  "$repo_root/apps/RelayiumKit/Tests/RelayiumKitTests/LocalizationIntegrityTests.swift"
  "$repo_root/apps/RelayiumKit/Tests/RelayiumKitTests/LocalizedCopyTests.swift"
  "$repo_root/apps/RelayiumKit/Tests/RelayiumKitTests/LocalizationSourceGuardTests.swift"
)
for source_path in "${localization_sources[@]}"; do
  if [ ! -f "$source_path" ]; then
    echo "error: localization evidence source is missing: $source_path" >&2
    exit 1
  fi
done

# The nine catalogs themselves, by name. `swift test` asserts far more about
# them, but this runs in the release path and needs no toolchain.
supported_lprojs=(en zh-Hans ja ko de fr ar es pt)
catalog_root="$repo_root/apps/RelayiumKit/Sources/RelayiumAppKit/Resources"
for lproj in "${supported_lprojs[@]}"; do
  if [ ! -f "$catalog_root/$lproj.lproj/Localizable.strings" ]; then
    echo "error: localization catalog is missing: $lproj.lproj/Localizable.strings" >&2
    exit 1
  fi
done

# Exactly nine, so a tenth language cannot be half-added: a catalog the app
# cannot select is a translation nobody will ever see, and it would pass every
# existence check above.
shipped_lproj_count="$(find "$catalog_root" -maxdepth 1 -type d -name '*.lproj' | wc -l | tr -d ' ')"
if [ "$shipped_lproj_count" != "${#supported_lprojs[@]}" ]; then
  echo "error: expected ${#supported_lprojs[@]} .lproj catalogs, found $shipped_lproj_count" >&2
  exit 1
fi

# And the APP has to declare the same nine. This is the one that decides layout
# direction: without `ar` in CFBundleLocalizations, macOS treats the app as
# English-only and lays an otherwise correct Arabic UI out left to right.
app_localizations="$(
  /usr/libexec/PlistBuddy -c "Print :CFBundleLocalizations" \
    "$repo_root/apps/mac/Relayium/Info.plist" 2>/dev/null | tr -d ' ' | sed '1d;$d'
)"
for lproj in "${supported_lprojs[@]}"; do
  if ! printf '%s\n' "$app_localizations" | grep -Fqx "$lproj"; then
    echo "error: Info.plist CFBundleLocalizations is missing $lproj" >&2
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

if [ "$(read_capability "$readiness" localization implemented)" != true ]; then
  echo "error: localization is implemented in the app but the manifest says otherwise" >&2
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
