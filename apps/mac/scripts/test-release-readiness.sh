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
  # Was RealtimeTextPane.swift, then the merged Workspace's two panes, then the
  # two connect screens plus one shared legacy session pane. That pane is gone
  # with the legacy transports it rendered: macOS composes one `link/1`, and an
  # ephemeral conversation is a LANE on it rather than a session of its own. So
  # the live/terminal half is now the unified link surface, and it is named here
  # in place of the deleted pane. The capability itself survives every one of
  # those moves — the user still starts a conversation from whichever connection
  # method they picked, and still compares one SAS before anything moves.
  "$repo_root/apps/mac/Relayium/Transfer/LanConnectPane.swift"
  "$repo_root/apps/mac/Relayium/Transfer/CrossNetworkConnectPane.swift"
  "$repo_root/apps/mac/Relayium/Transfer/TransferLinkPane.swift"
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
# so a rename or a bad merge can delete one of them and leave a build that
# compiles, runs, and silently renders English to everybody.
#
# The catalogs and the lookup moved from `RelayiumAppKit` to `RelayiumShareKit`
# so the iOS share extension could render the same languages without linking the
# transport stack. `RelayiumAppKit` re-exports the module, so every call site is
# unchanged — but these paths are not, and a stale list here would pass by
# checking for files that no longer exist anywhere.
localization_sources=(
  "$repo_root/apps/RelayiumKit/Sources/RelayiumShareKit/Localization/AppLanguage.swift"
  "$repo_root/apps/RelayiumKit/Sources/RelayiumShareKit/Localization/L10n.swift"
  "$repo_root/apps/RelayiumKit/Sources/RelayiumShareKit/Localization/L10nKey.swift"
  "$repo_root/apps/RelayiumKit/Sources/RelayiumShareKit/Localization/LocalizationCatalog.swift"
  "$repo_root/apps/RelayiumKit/Sources/RelayiumShareKit/Localization/PluralRule.swift"
  "$repo_root/apps/RelayiumKit/Sources/RelayiumAppKit/Localization/AppCopy.swift"
  "$repo_root/apps/RelayiumKit/Sources/RelayiumAppKit/SharedLocalizationExport.swift"
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

# The two shipped catalogs themselves, by name. `swift test` asserts far more
# about them, but this runs in the release path and needs no toolchain.
supported_lprojs=(en zh-Hans)
catalog_root="$repo_root/apps/RelayiumKit/Sources/RelayiumShareKit/Resources"
for lproj in "${supported_lprojs[@]}"; do
  if [ ! -f "$catalog_root/$lproj.lproj/Localizable.strings" ]; then
    echo "error: localization catalog is missing: $lproj.lproj/Localizable.strings" >&2
    exit 1
  fi
done

# Exactly two, so a third language cannot be half-added AND a frozen one cannot
# come back. `Package.swift` declares `.process("Resources")`, which packages
# every `.lproj` in that directory — so a catalog restored here SHIPS, whatever
# `AppLanguage` says, and would be a language the app advertises through the
# bundle but cannot select. This count is the check that catches it.
shipped_lproj_count="$(find "$catalog_root" -maxdepth 1 -type d -name '*.lproj' | wc -l | tr -d ' ')"
if [ "$shipped_lproj_count" != "${#supported_lprojs[@]}" ]; then
  echo "error: expected ${#supported_lprojs[@]} .lproj catalogs, found $shipped_lproj_count" >&2
  find "$catalog_root" -maxdepth 1 -type d -name '*.lproj' -exec basename {} \; >&2
  exit 1
fi

# The seven frozen catalogs have to still EXIST, outside the package. Freezing a
# translation and deleting it are different decisions, and only one of them was
# taken; a `git rm` that removed them would otherwise pass every check above.
archive_root="$repo_root/apps/RelayiumKit/LocalizationArchive/frozen-locales"
frozen_lprojs=(ar de es fr ja ko pt)
for lproj in "${frozen_lprojs[@]}"; do
  archived="$archive_root/$lproj.lproj/Localizable.strings"
  if [ ! -s "$archived" ]; then
    echo "error: frozen localization archive is missing or empty: $lproj.lproj" >&2
    exit 1
  fi
  if [ -e "$catalog_root/$lproj.lproj" ]; then
    echo "error: frozen locale $lproj.lproj is back inside the package resource root," \
         "which ships it" >&2
    exit 1
  fi
done

# And every Mac BUNDLE has to declare exactly the same two.
#
# Both directions matter, for different reasons. A missing entry is the one that
# decides layout and language matching: macOS treats an undeclared language as
# unsupported. An EXTRA entry is the stale-claim direction this contraction is
# about — a locale named here with no catalog behind it tells macOS, and App
# Store Connect, that Relayium speaks a language it will then render in English.
# The old check only looked for missing entries and would have passed a plist
# that still listed all nine.
for plist_rel in \
  "apps/mac/Relayium/Info.plist" \
  "apps/mac/RelayiumAppStore/Info.plist" \
  "apps/mac/RelayiumShare/Info.plist"; do
  declared="$(
    /usr/libexec/PlistBuddy -c "Print :CFBundleLocalizations" \
      "$repo_root/$plist_rel" 2>/dev/null | tr -d ' ' | sed '1d;$d'
  )"
  for lproj in "${supported_lprojs[@]}"; do
    if ! printf '%s\n' "$declared" | grep -Fqx "$lproj"; then
      echo "error: $plist_rel CFBundleLocalizations is missing $lproj" >&2
      exit 1
    fi
  done
  declared_count="$(printf '%s\n' "$declared" | grep -c . || true)"
  if [ "$declared_count" != "${#supported_lprojs[@]}" ]; then
    echo "error: $plist_rel CFBundleLocalizations must declare exactly" \
         "${supported_lprojs[*]}; found: $(printf '%s' "$declared" | tr '\n' ' ')" >&2
    exit 1
  fi
done

# The Xcode project's own region list, for the same reason. `knownRegions` is
# what Xcode offers and what a variant group resolves against; a frozen locale
# left here invites a build setting or a new .lproj to quietly re-adopt it.
pbxproj="$repo_root/apps/mac/Relayium.xcodeproj/project.pbxproj"
known_regions="$(
  sed -n '/knownRegions = (/,/);/p' "$pbxproj" | sed '1d;$d' | tr -d '\t",' | sed '/^$/d'
)"
for lproj in "${frozen_lprojs[@]}"; do
  if printf '%s\n' "$known_regions" | grep -Fqx "$lproj"; then
    echo "error: Relayium.xcodeproj knownRegions still lists frozen locale $lproj" >&2
    exit 1
  fi
done
for lproj in "${supported_lprojs[@]}"; do
  if ! printf '%s\n' "$known_regions" | grep -Fqx "$lproj"; then
    echo "error: Relayium.xcodeproj knownRegions is missing $lproj" >&2
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
