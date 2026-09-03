#!/usr/bin/env bash
# The contract of `scripts/ios-app-store-candidate.sh`, driven without an
# archive, a signing identity, a device, a credential or a network.
#
# ── why this test exists in this shape ───────────────────────────────────────
#
# The script under test produces an App Store candidate. Its whole value is in
# what it REFUSES — a stale App Store Connect read-back, an unpushed commit, an
# artifact root that already holds somebody's data, a toolchain Apple will not
# accept — and in the commands it never runs. Neither is observable from a
# successful build, and both are exactly the kind of property a well-meaning
# edit removes: the shortest path to "it worked on my machine" is to delete a
# guard.
#
# So the suite has two halves, and they answer different questions.
#
#   1. A POLICY PREDICATE over the script's source. It states what the file must
#      contain (the pinned team, both profile names, the export destination and
#      method, the symbol readback, the signature and privacy checks, the log
#      capture) and what it must never contain (an upload tool, an App Store
#      Connect endpoint, `-allowProvisioningUpdates`, a delete, a swallowed
#      failure). A predicate that passes on the current file proves nothing on
#      its own, so each rule is checked by MUTATION: edits are applied one at a
#      time to throwaway copies — the run's final line reports how many — and the
#      predicate must complain about every one. A rule that stays quiet when its
#      property is removed is not a rule.
#
#   2. EXECUTED refusals. The script really runs, in a temporary Git repository
#      of its own, against `xcodebuild` and `xcrun` stubs that record their argv
#      and build nothing. Every precondition is broken one at a time and the exit
#      status and message are read back. The last two cases satisfy every
#      precondition and then let the stub fail at a chosen stage: with the stub
#      refusing to archive, the generated export options, the exact archive argv
#      and the preserved archive log get asserted; with the stub creating the
#      requested `.xcarchive` and reporting success, the export runs and fails,
#      which is how the exact export argv and the preserved export log get
#      asserted. Neither fabricates a signed export, so neither reaches the
#      post-export verification half — that remains the operator's run.
#
# Nothing here signs, uploads, touches App Store Connect, reads a keychain or
# contacts a network. The fixtures live under a temporary directory and the
# real repository is only ever read.
#
# Requires macOS: the script under test is an `xcodebuild` wrapper and this
# suite uses `plutil` to read what it generated. On another platform the suite
# refuses rather than skipping, because a skipped gate reads like a passing one.
#
# USAGE: bash scripts/test/ios-app-store-candidate-test.sh

set -u

here="$(cd "$(dirname "$0")" && pwd)"
repo_root="$(cd "$here/../.." && pwd)"
script_name='ios-app-store-candidate.sh'
script_under_test="$repo_root/scripts/$script_name"

failures=0
ok()  { printf 'ok   — %s\n' "$1"; }
bad() { printf 'FAIL — %s\n     %s\n' "$1" "$2"; failures=$((failures + 1)); }

[ -f "$script_under_test" ] || { printf 'missing %s\n' "$script_under_test" >&2; exit 2; }
[ -f "$repo_root/scripts/ios-app-store-metadata-validate.mjs" ] ||
  { printf 'missing the metadata validator\n' >&2; exit 2; }
[ -f "$repo_root/docs/app-store-metadata-ios.json" ] ||
  { printf 'missing the metadata packet\n' >&2; exit 2; }
# The validator cross-checks the packet against the two SHIPPED privacy
# manifests, resolved from its own location rather than from the packet's. The
# fixture repository below therefore has to carry them too, and a missing
# source-of-truth file is a broken checkout rather than a test failure.
[ -f "$repo_root/apps/ios/Relayium/PrivacyInfo.xcprivacy" ] ||
  { printf "missing the app's privacy manifest\n" >&2; exit 2; }
[ -f "$repo_root/apps/ios/RelayiumShare/PrivacyInfo.xcprivacy" ] ||
  { printf "missing the Share extension's privacy manifest\n" >&2; exit 2; }
[ -x "$script_under_test" ] || { printf '%s is not executable\n' "$script_under_test" >&2; exit 2; }

case "$(uname -s)" in
  Darwin) ;;
  *) printf 'this suite requires macOS (plutil, and the xcodebuild wrapper it tests)\n' >&2; exit 2 ;;
esac
command -v plutil >/dev/null 2>&1 || { printf 'plutil is required\n' >&2; exit 2; }
command -v git >/dev/null 2>&1 || { printf 'git is required\n' >&2; exit 2; }
command -v node >/dev/null 2>&1 || { printf 'node is required by the metadata gate\n' >&2; exit 2; }

work="$(mktemp -d "${TMPDIR:-/tmp}/ios-app-store-candidate-test.XXXXXX")"
work="$(cd "$work" && pwd -P)"
trap 'rm -rf "$work"' EXIT

# ─────────────────────────────────────────────────────────────────────────────
# Part 1 — the policy predicate, and the mutations that must break it
# ─────────────────────────────────────────────────────────────────────────────

# Full-line comments are stripped before the FORBIDDEN scan and kept for the
# REQUIRED one. The file argues for its own design at length, and that prose
# necessarily contains the words "upload", "App Store Connect" and "delete";
# scanning it for those would make the ban unenforceable rather than strict.
strip_comments() { awk '{ if ($0 ~ /^[[:space:]]*#/) print ""; else print }' "$1"; }

# Each rule is `regex<TAB>what its absence would mean`. Written as extended
# regular expressions over the file, one line at a time.
required_rules() {
  cat <<'RULES'
^set -euo pipefail$	the script would continue past a failed command, an unset variable or a failed pipeline
^readonly EXPECTED_TEAM='7PVYUG4YQS'$	the pinned team is gone; any team could sign a candidate
^readonly TARGET_APPLE_ID='6801142976'$	the target App Store record is no longer named, so a refusal cannot say which record it is about
^readonly OBSERVED_HIGHEST_BUILD_FLOOR='4'$	the observed build-number floor is gone; a read-back attestation of 0 would be accepted again
^readonly APP_BUNDLE_ID='com\.relayium\.mac'$	the pinned app bundle identifier is gone, or has reverted to the retired separate-record one
^readonly SHARE_BUNDLE_ID='com\.relayium\.mac\.ShareIOS'$	the pinned Share extension bundle identifier is gone, or has collided with the macOS appex
^readonly APP_PROFILE='Relayium iOS Universal App Store'$	the pinned app provisioning profile is gone
^readonly SHARE_PROFILE='Relayium iOS Share Extension App Store'$	the pinned Share provisioning profile is gone
^readonly EXPORT_DESTINATION='export'$	the export could target upload instead of a local export
^readonly EXPORT_METHOD='app-store-connect'$	the export method is no longer the App Store one
^readonly EXPORT_SIGNING_STYLE='manual'$	signing could fall back to automatic, which resolves profiles Xcode chooses
^readonly REQUIRED_XCODE_MAJOR=26$	the required Xcode major is gone; Apple rejects uploads from another major
^readonly MIN_IPHONEOS_SDK_MAJOR=26$	the iphoneos SDK floor is gone
^readonly READBACK_MAX_AGE_SECONDS=	a read-back of any age would authorize a build number
^next_free_build="\$\(decimal_increment "\$readback_highest_build"\)"$	the two supplied build numbers are no longer cross-checked
^if \[ "\$build_number" != "\$next_free_build" \]; then$	the next-free comparison is gone, or has gone back to fixed-width shell arithmetic that wraps
^if decimal_less_than "\$readback_highest_build" "\$OBSERVED_HIGHEST_BUILD_FLOOR"; then$	the attestation is no longer held against the build number observed on the target record
status --porcelain	a dirty worktree could become a candidate
@\{upstream\}	an unpushed commit could become a candidate
already exists	an existing caller directory could be written into
-configuration "\$CONFIGURATION"	the archive is no longer pinned to a configuration
-destination "\$ARCHIVE_DESTINATION"	the archive is no longer pinned to a generic iOS device
-archivePath "\$archive_path"	the archive has no explicit destination inside the artifact root
-exportArchive	nothing exports the archive
-exportOptionsPlist "\$export_options"	the export no longer uses the options this script generated
tee "\$archive_log"	the complete archive log is no longer captured
tee "\$export_log"	the complete export log is no longer captured
plutil -lint "\$export_options"	the generated export options are no longer validated
codesign --verify --strict	the exported bundles' signatures are no longer verified
TeamIdentifier=	the signing team of the exported bundles is no longer checked
Authority=	the distribution authority of the exported bundles is no longer checked
get-task-allow	a debuggable distribution build would pass verification
xcrun nm -u	the AVCapture undefined-symbol readback is gone
AVCapture	the camera symbol readback is gone
PrivacyInfo\.xcprivacy	the built privacy manifests are no longer checked
^readonly APP_REQUIRED_REASON_GRAPH='NSPrivacyAccessedAPICategoryDiskSpace[[:space:]]E174\.1$	the app's pinned graph no longer opens with the Disk Space declaration and its E174.1 reason
^NSPrivacyAccessedAPICategoryFileTimestamp[[:space:]]DDA9\.1$	the app's pinned graph no longer declares the file-timestamp category
^NSPrivacyAccessedAPICategorySystemBootTime[[:space:]]35F9\.1$	the app's pinned graph no longer declares the system-boot-time category
^NSPrivacyAccessedAPICategoryUserDefaults[[:space:]]CA92\.1'$	the app's pinned graph no longer declares the user-defaults category, or is no longer terminated
^readonly SHARE_REQUIRED_REASON_GRAPH='NSPrivacyAccessedAPICategoryFileTimestamp[[:space:]]DDA9\.1'$	the Share extension's smaller pinned graph is gone; the appex could ship the app's
^required_reason_graph_of\(\) \{$	nothing reads a built manifest's required-reason graph
^readonly APP_COLLECTED_DATA_GRAPH='NSPrivacyCollectedDataTypeEmailAddress[[:space:]]true[[:space:]]false[[:space:]]NSPrivacyCollectedDataTypePurposeAppFunctionality$	the app's pinned collected-data graph no longer opens with the linked, non-tracking email declaration
^NSPrivacyCollectedDataTypeName[[:space:]]true[[:space:]]false[[:space:]]NSPrivacyCollectedDataTypePurposeAppFunctionality$	the pinned collected-data graph no longer declares Name, which the account form and Sign in with Apple both send
^NSPrivacyCollectedDataTypeOtherUsageData[[:space:]]true[[:space:]]false[[:space:]]NSPrivacyCollectedDataTypePurposeAppFunctionality$	the pinned collected-data graph no longer declares the metering counters, including the Device Inbox delivery meter
^NSPrivacyCollectedDataTypeProductInteraction[[:space:]]false[[:space:]]false[[:space:]]NSPrivacyCollectedDataTypePurposeAnalytics$	the identifier-free aggregate is gone, or is no longer the UNLINKED Analytics entry it must be
^NSPrivacyCollectedDataTypePurchaseHistory[[:space:]]true[[:space:]]false[[:space:]]NSPrivacyCollectedDataTypePurposeAppFunctionality$	the pinned collected-data graph no longer declares the StoreKit transaction
^NSPrivacyCollectedDataTypeUserID[[:space:]]true[[:space:]]false[[:space:]]NSPrivacyCollectedDataTypePurposeAppFunctionality'$	the pinned collected-data graph no longer declares the appAccountToken, or is no longer terminated
^readonly SHARE_COLLECTED_DATA_GRAPH=''$	the Share extension is no longer pinned to collecting NOTHING; the appex could be checked against the app's list and pass while shipping the app's manifest
^collected_data_graph_of\(\) \{$	nothing reads a built manifest's collected-data graph, so the App Store privacy label is unchecked
expect_collected_data_graph "\$archive_app_dir/PrivacyInfo\.xcprivacy"	the ARCHIVED app's collected-data graph is no longer verified
expect_collected_data_graph "\$archive_appex_dir/PrivacyInfo\.xcprivacy"	the ARCHIVED Share extension is no longer proved to collect nothing
expect_collected_data_graph "\$app_dir/PrivacyInfo\.xcprivacy"	the EXPORTED app's collected-data graph is no longer verified
expect_collected_data_graph "\$appex_dir/PrivacyInfo\.xcprivacy"	the EXPORTED Share extension is no longer proved to collect nothing
LC_ALL=C sort	the graph is no longer canonically ordered, so entry order in the plist would decide the comparison
expect_required_reason_graph "\$archive_app_dir/PrivacyInfo\.xcprivacy"	the ARCHIVED app's required-reason graph is no longer verified
expect_required_reason_graph "\$archive_appex_dir/PrivacyInfo\.xcprivacy"	the ARCHIVED Share extension's required-reason graph is no longer verified
expect_required_reason_graph "\$app_dir/PrivacyInfo\.xcprivacy"	the EXPORTED app's required-reason graph is no longer verified
expect_required_reason_graph "\$appex_dir/PrivacyInfo\.xcprivacy"	the EXPORTED Share extension's required-reason graph is no longer verified
plutil -lint "\$file"	a shipped manifest is accepted without proving it is a valid plist
NSCameraUsageDescription	the camera purpose declaration is no longer checked
NSLocalNetworkUsageDescription	the local network purpose declaration is no longer checked
expect_plist_key_absent "\$appex_info" .*NSCameraUsageDescription	the Share extension could declare a camera purpose string
-name '\*\.lproj'	the Share extension could carry localized purpose strings
com\.apple\.developer\.applesignin	the Sign in with Apple boundary is no longer checked
com\.apple\.developer\.associated-domains	the associated-domains boundary is no longer checked
com\.apple\.security\.application-groups	the App Group entitlement is no longer checked
shasum -a 256	the candidate is no longer checksummed
candidate-manifest\.txt	the human-readable evidence manifest is gone
candidate-manifest\.json	the machine-readable evidence manifest is gone
metadata_packet="\$repo_root/docs/app-store-metadata-ios\.json"	the App Store metadata packet is no longer located, so nothing is validated
metadata_validator="\$repo_root/scripts/ios-app-store-metadata-validate\.mjs"	the App Store metadata validator is no longer located
node "\$metadata_validator"	the App Store metadata packet is never validated; a rejected subtitle, keyword list or claim would reach the submission
--expect-version "\$marketing_version"	the metadata packet is no longer tied to THIS candidate's marketing version, so a What's New drafted for another version would pass
RULES
}

# Scanned with comments stripped. Each is a command or configuration that would
# turn this script from a builder into a publisher, a mutator or a liar.
forbidden_rules() {
  cat <<'RULES'
altool	an App Store upload tool
notarytool	a notarization submission
iTMSTransporter	an App Store Connect transport tool
[Tt]ransporter	an App Store Connect transport tool
appstoreconnect\.apple\.com	a direct App Store Connect API call
api\.apple\.com	an Apple provider API call
-allowProvisioningUpdates	authority for Xcode to create or modify provisioning profiles in the account
<string>upload</string>	an export configured to upload
EXPORT_DESTINATION='upload'	an export configured to upload
--upload-app	an upload invocation
--upload-package	an upload invocation
gh (release|api)	a GitHub release or API mutation
(^|[^[:alnum:]_])rm[[:space:]]	a delete
(^|[^[:alnum:]_])rmdir[[:space:]]	a directory delete
-delete	a find-driven delete
\|\| true	a swallowed failure
\|\| :	a swallowed failure
^[[:space:]]*set \+e	error handling turned off
git .*[[:space:]](push|commit|checkout|reset|clean|stash)([[:space:]]|$)	a repository mutation
<true/>	the build number could be managed by the export
RULES
}

# `manageAppVersionAndBuildNumber` must be followed by `<false/>` everywhere it
# appears — in the generated export options and in the manifest that reports
# them. A separate check because it is a two-line fact and the scans above read
# one line at a time.
manage_version_is_false() {
  awk '
    previous ~ /manageAppVersionAndBuildNumber<\/key>/ && $0 !~ /<false\/>/ { bad = 1 }
    { previous = $0 }
    END { if (bad) exit 1 }
  ' "$1"
}

# The metadata packet has to be validated BEFORE anything is built, and before
# the artifact root exists — otherwise a rejected packet has already left a
# directory behind, and in the worst ordering a signed archive as well. Textual
# presence cannot say that: a validation call that has drifted below the archive
# reads exactly like one that runs first. So the line NUMBERS are compared, in
# the order the ladder is meant to run:
#
#   validate the packet  ->  create the artifact root  ->  read the project
#   settings  ->  archive
#
# One `xcodebuild` invocation legitimately precedes all of this and is not
# checked here: the toolchain section's `xcodebuild -version` / `xcrun
# --show-sdk-version` probe. It compiles nothing, signs nothing, writes nothing
# and creates no path, so it is not a stage a rejected packet can taint. Every
# invocation that reads the project or produces an artifact is after the gate.
metadata_validation_runs_first() {
  local file="$1" validate root settings archive
  validate="$(grep -n 'node "$metadata_validator"' "$file" | head -1 | cut -d: -f1)"
  root="$(grep -n 'mkdir "$artifact_resolved"' "$file" | head -1 | cut -d: -f1)"
  settings="$(grep -n -- '-showBuildSettings' "$file" | head -1 | cut -d: -f1)"
  archive="$(grep -n -- '-archivePath "$archive_path"' "$file" | head -1 | cut -d: -f1)"
  [ -n "$validate" ] && [ -n "$root" ] && [ -n "$settings" ] && [ -n "$archive" ] || return 1
  [ "$validate" -lt "$root" ] &&
    [ "$root" -lt "$settings" ] &&
    [ "$settings" -lt "$archive" ]
}

# The predicate. Prints one complaint per violated rule and returns non-zero if
# there was any.
policy_scan() {
  local file="$1" stripped="$work/stripped.$$"
  local complaints=0 pattern reason

  while IFS=$'\t' read -r pattern reason; do
    [ -n "$pattern" ] || continue
    if ! grep -Eq -e "$pattern" "$file"; then
      printf 'missing: %s (%s)\n' "$pattern" "$reason"
      complaints=$((complaints + 1))
    fi
  done < <(required_rules)

  strip_comments "$file" >"$stripped"
  while IFS=$'\t' read -r pattern reason; do
    [ -n "$pattern" ] || continue
    if grep -Eq -e "$pattern" "$stripped"; then
      printf 'forbidden: %s (%s)\n' "$pattern" "$reason"
      complaints=$((complaints + 1))
    fi
  done < <(forbidden_rules)
  rm -f "$stripped"

  if ! manage_version_is_false "$file"; then
    printf 'forbidden: manageAppVersionAndBuildNumber is not false (the export could renumber the build)\n'
    complaints=$((complaints + 1))
  fi

  if ! metadata_validation_runs_first "$file"; then
    printf 'out of order: the metadata packet is not validated before the artifact root is created, the project settings are read and the archive runs\n'
    complaints=$((complaints + 1))
  fi

  [ "$complaints" -eq 0 ]
}

complaints="$(policy_scan "$script_under_test")" && status=0 || status=$?
if [ "$status" -ne 0 ]; then
  bad "the shipped script satisfies its own policy" "$complaints"
else
  ok "the shipped script satisfies its own policy"
fi

# ── the mutations ────────────────────────────────────────────────────────────
#
# Each applies one edit to a copy and requires the predicate to complain. A
# mutation that leaves the predicate quiet means the rule it targets is
# decorative.

mutation_number=0
mutate() {
  local label="$1"; shift
  mutation_number=$((mutation_number + 1))
  local copy="$work/mutant-$mutation_number.sh"
  cp "$script_under_test" "$copy"
  # Every mutator reads the copy on stdin and writes the mutated file.
  "$@" <"$copy" >"$copy.new" && mv "$copy.new" "$copy"
  if cmp -s "$copy" "$script_under_test"; then
    bad "mutation '$label' changes the file" 'the mutator was a no-op; the rule it targets was never exercised'
    return
  fi
  if policy_scan "$copy" >/dev/null; then
    bad "mutation '$label' is caught" 'the policy predicate stayed quiet'
  else
    ok "mutation '$label' is caught"
  fi
}

# Both are invoked indirectly, through `mutate`'s "$@", which is why each
# carries an SC2329 exemption. Every mutation argument below is additionally
# single-quoted on purpose: it is LITERAL source text, and a `$archive_log`
# that expanded here would mutate nothing. ShellCheck reports that as SC2016 at
# each call site, at info severity; the gate this repository runs is
# `shellcheck -x -S warning`, which this file passes cleanly.
# shellcheck disable=SC2329
sed_mutator() { sed -E "$1"; }
# shellcheck disable=SC2329
append_mutator() { cat; printf '%s\n' "$1"; }

mutate 'export destination becomes upload' \
  sed_mutator "s/^readonly EXPORT_DESTINATION='export'$/readonly EXPORT_DESTINATION='upload'/"
mutate 'export method stops being the App Store one' \
  sed_mutator "s/^readonly EXPORT_METHOD='app-store-connect'$/readonly EXPORT_METHOD='ad-hoc'/"
mutate 'signing style becomes automatic' \
  sed_mutator "s/^readonly EXPORT_SIGNING_STYLE='manual'$/readonly EXPORT_SIGNING_STYLE='automatic'/"
mutate 'the export is allowed to manage the build number' \
  awk '{ if (previous ~ /manageAppVersionAndBuildNumber<\/key>/) sub(/<false\/>/, "<true/>"); previous = $0; print }'
mutate 'the pinned team is replaced' \
  sed_mutator "s/^readonly EXPECTED_TEAM='7PVYUG4YQS'$/readonly EXPECTED_TEAM='AAAAAAAAAA'/"
mutate 'the Share provisioning profile is dropped' \
  sed_mutator "/^readonly SHARE_PROFILE=/d"
mutate 'the required Xcode major is removed' \
  sed_mutator "s/^readonly REQUIRED_XCODE_MAJOR=26$/readonly REQUIRED_XCODE_MAJOR=0/"
mutate 'the read-back freshness bound is removed' \
  sed_mutator "/^readonly READBACK_MAX_AGE_SECONDS=/d"
mutate 'the two build numbers stop being cross-checked' \
  sed_mutator 's/decimal_increment "\$readback_highest_build"/printf %s "\$readback_highest_build"/'
mutate 'the next-free comparison goes back to shell arithmetic' \
  sed_mutator 's/\[ "\$build_number" != "\$next_free_build" \]/[ "$((10#$build_number))" -ne "$((10#$next_free_build))" ]/'
mutate 'the observed build-number floor is removed' \
  sed_mutator "/^readonly OBSERVED_HIGHEST_BUILD_FLOOR=/d"
mutate 'the target record is no longer named' \
  sed_mutator "/^readonly TARGET_APPLE_ID=/d"
mutate 'the clean-worktree check is removed' \
  sed_mutator "/status --porcelain/d"
mutate 'the upstream check is removed' \
  sed_mutator "/@\{upstream\}/d"
mutate 'error handling is turned off' \
  sed_mutator "s/^set -euo pipefail$/set -uo pipefail\nset +e/"
mutate 'the archive log capture is removed' \
  sed_mutator 's/ 2>&1 \| tee "\$archive_log"//'
mutate 'the signature verification is removed' \
  sed_mutator "/codesign --verify --strict/d"
mutate 'the AVCapture symbol readback is removed' \
  sed_mutator "/xcrun nm -u/d"
mutate 'the Share camera-absence check is removed' \
  sed_mutator '/expect_plist_key_absent "\$appex_info"/d'
mutate 'the privacy manifest check is removed' \
  sed_mutator "s/PrivacyInfo\.xcprivacy/PrivacyInfo.absent/g"
mutate 'the pinned app required-reason graph is deleted' \
  sed_mutator "/^readonly APP_REQUIRED_REASON_GRAPH=/d"
mutate 'the Disk Space reason code is changed' \
  sed_mutator 's/E174\.1/E174.2/g'
mutate 'the Share extension is pinned to the app graph instead of its own' \
  sed_mutator 's/^readonly SHARE_REQUIRED_REASON_GRAPH=.*$/readonly SHARE_REQUIRED_REASON_GRAPH="$APP_REQUIRED_REASON_GRAPH"/'
mutate 'nothing reads a built manifest as a graph' \
  sed_mutator '/^required_reason_graph_of\(\) \{$/d'
mutate 'the archived bundles stop being checked' \
  sed_mutator '/expect_required_reason_graph "\$archive_/d'
mutate 'the exported app stops being checked' \
  sed_mutator '/expect_required_reason_graph "\$app_dir/d'
mutate 'the exported Share extension stops being checked' \
  sed_mutator '/expect_required_reason_graph "\$appex_dir/d'
mutate 'the graph comparison stops being canonically ordered' \
  sed_mutator 's/LC_ALL=C sort/cat/'
mutate 'a shipped manifest is no longer linted' \
  sed_mutator '/plutil -lint "\$file"/d'
mutate 'the pinned collected-data graph is deleted' \
  sed_mutator "/^readonly APP_COLLECTED_DATA_GRAPH=/d"
mutate 'a declared collected-data type is dropped from the pinned graph' \
  sed_mutator '/^NSPrivacyCollectedDataTypeOtherUsageData	/d'
# DeviceID takes a DECLARED line's place rather than being appended after it.
# Appending would need a newline in the replacement, and BSD `sed` does not read
# `\n` there as one — the mutation would insert a literal `n`, or match nothing
# at all, and `mutate` would report a no-op instead of exercising the rule. A
# substitution needs no newline and removes a pinned line, which is what the
# predicate is watching for.
mutate 'DeviceID replaces a declared type in the pinned collected-data graph' \
  sed_mutator 's/^NSPrivacyCollectedDataTypeName	true	false	NSPrivacyCollectedDataTypePurposeAppFunctionality$/NSPrivacyCollectedDataTypeDeviceID	true	false	NSPrivacyCollectedDataTypePurposeAppFunctionality/'
mutate 'the identifier-free aggregate is dropped from the pinned graph' \
  sed_mutator '/^NSPrivacyCollectedDataTypeProductInteraction	/d'
mutate 'the identifier-free aggregate is pinned as linked to the account' \
  sed_mutator 's/^NSPrivacyCollectedDataTypeProductInteraction	false	false	/NSPrivacyCollectedDataTypeProductInteraction	true	false	/'
mutate 'a collected-data purpose is changed' \
  sed_mutator 's/^NSPrivacyCollectedDataTypeName	true	false	NSPrivacyCollectedDataTypePurposeAppFunctionality$/NSPrivacyCollectedDataTypeName	true	false	NSPrivacyCollectedDataTypePurposeAnalytics/'
mutate 'nothing reads a built manifest as a collected-data graph' \
  sed_mutator '/^collected_data_graph_of\(\) \{$/d'
mutate 'the archived bundles stop having their collected data checked' \
  sed_mutator '/expect_collected_data_graph "\$archive_/d'
mutate 'the exported app stops having its collected data checked' \
  sed_mutator '/expect_collected_data_graph "\$app_dir/d'
mutate 'the exported Share extension stops being proved to collect nothing' \
  sed_mutator '/expect_collected_data_graph "\$appex_dir/d'
mutate 'the Share extension is allowed to declare the app collected-data graph' \
  sed_mutator 's/^readonly SHARE_COLLECTED_DATA_GRAPH=.*$/readonly SHARE_COLLECTED_DATA_GRAPH="$APP_COLLECTED_DATA_GRAPH"/'
mutate 'provisioning updates are allowed' \
  append_mutator '  xcodebuild -allowProvisioningUpdates archive'
mutate 'an upload tool is added' \
  append_mutator 'xcrun altool --upload-app -f "$ipa_path" -t ios'
mutate 'a notarization submission is added' \
  append_mutator 'xcrun notarytool submit "$ipa_path"'
mutate 'a GitHub release is added' \
  append_mutator 'gh release create ios-candidate "$ipa_path"'
mutate 'the artifact root is deleted afterwards' \
  append_mutator 'rm -rf "$artifact_root"'
mutate 'a validation failure is swallowed' \
  append_mutator 'codesign --verify --strict "$app_dir" || true'
mutate 'the repository is mutated' \
  append_mutator 'git -C "$repo_root" push origin HEAD'
mutate 'the metadata packet is never validated' \
  sed_mutator '/node "\$metadata_validator"/d'
mutate 'the metadata packet is no longer located' \
  sed_mutator '/^metadata_packet="\$repo_root/d'
mutate 'the metadata validator is no longer located' \
  sed_mutator '/^metadata_validator="\$repo_root/d'
mutate 'the packet stops being tied to this candidate version' \
  sed_mutator 's/--expect-version "\$marketing_version"/--expect-version 0.3.0/'
mutate 'the metadata validation drifts below the project settings' \
  awk '{ if ($0 ~ /node "\$metadata_validator"/) { held = 1; next } if (held && $0 ~ /-showBuildSettings/) { print "  node \"$metadata_validator\" --packet \"$metadata_packet\" --expect-version \"$marketing_version\""; held = 0 } print }'
mutate 'the metadata validation drifts below the archive' \
  awk '{ if ($0 ~ /node "\$metadata_validator"/) next; print } END { print "node \"$metadata_validator\" --packet \"$metadata_packet\" --expect-version \"$marketing_version\"" }'

# ─────────────────────────────────────────────────────────────────────────────
# Part 1b — the key paths the verification half reads with
# ─────────────────────────────────────────────────────────────────────────────
#
# The verification half cannot be executed here: it reads a SIGNED bundle, and
# `codesign -d --entitlements` has nothing to say about a fabricated one. What
# CAN be executed is the thing that half gets wrong most easily, and did get
# wrong once in this file's own history: the plutil key path.
#
# `plutil` treats `.` as a separator, and this script reads both kinds of key
# that collide with it — an entitlement name full of literal dots, and the
# archive's nested `ApplicationProperties` dictionary. An escaped nested path
# names a top-level key that does not exist, and the check that used it would
# have reported "absent" for a version that was present and correct: a silent
# pass through a gate, which is the worst shape a bug in this file can take.
#
# So `plutil_path` is lifted out of the shipped script — not reimplemented — and
# driven against fixtures shaped like the two plists it is used on.

eval "$(sed -n '/^plutil_path() {/,/^}/p' "$script_under_test")"
if ! declare -f plutil_path >/dev/null 2>&1; then
  bad 'plutil_path can be lifted out of the script' 'the function was not found or did not parse'
else
  fixtures="$work/plist-fixtures"
  mkdir -p "$fixtures"

  cat >"$fixtures/archive-info.plist" <<'FIXTURE'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>ApplicationProperties</key>
	<dict>
	<key>CFBundleIdentifier</key>
		<string>com.relayium.mac</string>
		<key>CFBundleShortVersionString</key>
		<string>0.3.0</string>
		<key>CFBundleVersion</key>
		<string>6</string>
		<key>SigningIdentity</key>
		<string>Apple Distribution: Example (7PVYUG4YQS)</string>
	</dict>
</dict>
</plist>
FIXTURE

  cat >"$fixtures/entitlements.plist" <<'FIXTURE'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>application-identifier</key>
	<string>7PVYUG4YQS.com.relayium.mac</string>
	<key>com.apple.developer.applesignin</key>
	<array>
		<string>Default</string>
	</array>
	<key>com.apple.security.application-groups</key>
	<array>
		<string>group.com.relayium.app</string>
	</array>
</dict>
</plist>
FIXTURE

  expect_path() {
    local label="$1" file="$2" expected="$3" format="$4"; shift 4
    local key_path actual
    key_path="$(plutil_path "$@")"
    actual="$(plutil -extract "$key_path" "$format" -o - "$file" 2>/dev/null)"
    if [ "$actual" = "$expected" ]; then
      ok "$label"
    else
      bad "$label" "path '$key_path' read '$actual', expected '$expected'"
    fi
  }

  expect_path 'a nested archive path reaches the bundle identifier' \
    "$fixtures/archive-info.plist" 'com.relayium.mac' raw ApplicationProperties CFBundleIdentifier
  expect_path 'a nested archive path reaches the build number' \
    "$fixtures/archive-info.plist" '6' raw ApplicationProperties CFBundleVersion
  expect_path 'a nested archive path reaches the signing identity' \
    "$fixtures/archive-info.plist" 'Apple Distribution: Example (7PVYUG4YQS)' raw ApplicationProperties SigningIdentity
  expect_path 'a dotted entitlement name is read as one literal key' \
    "$fixtures/entitlements.plist" '["Default"]' json 'com.apple.developer.applesignin'
  expect_path 'a dotted App Group entitlement is read as one literal key' \
    "$fixtures/entitlements.plist" '["group.com.relayium.app"]' json 'com.apple.security.application-groups'
  expect_path 'an undotted entitlement name still works' \
    "$fixtures/entitlements.plist" '7PVYUG4YQS.com.relayium.mac' raw 'application-identifier'

  # The converse, and the reason the separator must not be escaped away: a
  # nested path written as ONE component names a top-level key that is not
  # there, and the absence must be reported as an absence.
  if plutil -extract "$(plutil_path 'ApplicationProperties.CFBundleVersion')" raw -o - \
      "$fixtures/archive-info.plist" >/dev/null 2>&1; then
    bad 'a nested path written as one component does not silently resolve' \
        'the escaped single-component path resolved, so the separator semantics are not what this suite assumes'
  else
    ok 'a nested path written as one component does not silently resolve'
  fi

  # An absent key must fail rather than return an empty success, because every
  # `expect_plist_key_absent` in the script depends on exactly that.
  if plutil -extract "$(plutil_path 'get-task-allow')" raw -o - \
      "$fixtures/entitlements.plist" >/dev/null 2>&1; then
    bad 'an absent entitlement is reported as absent' 'the extraction succeeded'
  else
    ok 'an absent entitlement is reported as absent'
  fi
fi

# ─────────────────────────────────────────────────────────────────────────────
# Part 1c — the required-reason graph reader, driven adversarially
# ─────────────────────────────────────────────────────────────────────────────
#
# A privacy manifest is a PUBLIC STATEMENT: it becomes the App Store privacy
# label, and the app builds, signs and runs identically whether it is accurate,
# wrong or absent. Nothing at runtime notices. So the check that reads it out of
# a built bundle is doing all the work, and — unlike the signature and
# entitlement checks — it needs no signing identity, which means its failure
# modes can be OBSERVED here rather than left to the operator run.
#
# The rules in Part 1 prove the four call sites exist. They cannot prove the
# comparison behind those call sites actually rejects a wrong manifest, and a
# graph reader is exactly the kind of code that goes quiet: a set-shaped reader
# silently collapses a duplicated category, an unordered one makes the answer
# depend on entry order in the plist, and any reader that returns an empty graph
# on an unreadable file turns "malformed" into "does not match" — or worse, into
# a match against an empty expectation.
#
# So `required_reason_graph_of` and `expect_required_reason_graph` are LIFTED out
# of the shipped script — not reimplemented — and driven against manifests built
# here. The reporting helpers are replaced by counters, so "fails closed" is
# something this suite watches happen rather than infers from a return value.

eval "$(sed -n '/^plist_value() {/,/^}/p' "$script_under_test")"
eval "$(sed -n '/^expect_plist_value() {/,/^}/p' "$script_under_test")"
eval "$(sed -n '/^required_reason_graph_of() {/,/^}/p' "$script_under_test")"
eval "$(sed -n '/^expect_required_reason_graph() {/,/^}/p' "$script_under_test")"
eval "$(sed -n "/^readonly APP_REQUIRED_REASON_GRAPH=/,/CA92\.1'\$/p" "$script_under_test")"
eval "$(sed -n '/^readonly SHARE_REQUIRED_REASON_GRAPH=/p' "$script_under_test")"

lifted_ok=1
for lifted in plist_value expect_plist_value required_reason_graph_of \
    expect_required_reason_graph; do
  if ! declare -f "$lifted" >/dev/null 2>&1; then
    bad "$lifted can be lifted out of the script" 'the function was not found or did not parse'
    lifted_ok=0
  fi
done
if [ -z "${APP_REQUIRED_REASON_GRAPH:-}" ] || [ -z "${SHARE_REQUIRED_REASON_GRAPH:-}" ]; then
  bad 'the pinned required-reason graphs can be lifted out of the script' \
      'one of the two constants did not parse'
  lifted_ok=0
fi

if [ "$lifted_ok" -eq 1 ]; then
  # The script's reporting helpers, replaced. Only findings are counted: a
  # `pass_check` is the checker saying nothing is wrong, and "nothing was
  # raised" is already the assertion. Both are invoked indirectly, through the
  # lifted functions, which is why each carries an SC2329 exemption.
  lifted_failures=0
  # shellcheck disable=SC2329
  fail_check() { lifted_failures=$((lifted_failures + 1)); }
  # shellcheck disable=SC2329
  pass_check() { :; }

  manifests="$work/manifest-fixtures"
  mkdir -p "$manifests"

  # One `NSPrivacyAccessedAPITypes` entry: a category and its reasons, in the
  # order given. Reasons are a list rather than a single value so a DUPLICATED
  # reason can be expressed, which is one of the shapes under test.
  #
  # Every caller takes this through `$( )`, which strips the trailing newline,
  # so two concatenated entries share a line. That is deliberate and harmless:
  # the consumer is an XML parser, and pinning the whitespace would be pinning
  # something plutil does not read.
  api_entry() {
    local category="$1"; shift
    local reason
    printf '\t\t<dict>\n'
    printf '\t\t\t<key>NSPrivacyAccessedAPIType</key>\n\t\t\t<string>%s</string>\n' "$category"
    printf '\t\t\t<key>NSPrivacyAccessedAPITypeReasons</key>\n\t\t\t<array>\n'
    for reason in "$@"; do printf '\t\t\t\t<string>%s</string>\n' "$reason"; done
    printf '\t\t\t</array>\n\t\t</dict>'
  }

  # A whole manifest around a body of entries, at a path the CALLER names.
  #
  # The name is a parameter rather than a counter for a reason worth keeping:
  # every call site reaches this through `$( )`, which runs it in a subshell, so
  # a counter incremented here would not survive the call. Each fixture would
  # have been written to the same path and silently overwritten by the next —
  # and the assertions that reuse a fixture later would have been reading
  # somebody else's manifest.
  write_manifest() {
    local path="$manifests/$1.xcprivacy" body="$2"
    cat >"$path" <<MANIFEST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>NSPrivacyTracking</key>
	<false/>
	<key>NSPrivacyTrackingDomains</key>
	<array/>
	<key>NSPrivacyCollectedDataTypes</key>
	<array/>
	<key>NSPrivacyAccessedAPITypes</key>
	<array>
$body
	</array>
</dict>
</plist>
MANIFEST
    printf '%s' "$path"
  }

  # The four entries the iOS app really declares, and the one the extension does.
  disk_space_entry="$(api_entry NSPrivacyAccessedAPICategoryDiskSpace E174.1)"
  file_timestamp_entry="$(api_entry NSPrivacyAccessedAPICategoryFileTimestamp DDA9.1)"
  boot_time_entry="$(api_entry NSPrivacyAccessedAPICategorySystemBootTime 35F9.1)"
  user_defaults_entry="$(api_entry NSPrivacyAccessedAPICategoryUserDefaults CA92.1)"
  real_app_body="$user_defaults_entry$file_timestamp_entry$boot_time_entry$disk_space_entry"

  # ── the reader accepts what it must accept ─────────────────────────────────
  #
  # First, and most importantly: the manifests this repository actually ships
  # must produce exactly the graphs the script pins. This is the one assertion
  # that ties the two halves together — `IOSPrivacyManifestTests` derives the
  # graphs from the source that justifies them, the script states them
  # independently, and if those two statements ever disagree the operator's run
  # would fail on a correct build.
  expect_reader() {
    local label="$1" file="$2" expected="$3" actual
    if ! actual="$(required_reason_graph_of "$file")"; then
      bad "$label" "the reader refused $file"
      return
    fi
    if [ "$actual" = "$expected" ]; then
      ok "$label"
    else
      bad "$label" "read '$actual', expected '$expected'"
    fi
  }

  expect_reader "the shipped iOS app manifest reads back as the script's pinned app graph" \
    "$repo_root/apps/ios/Relayium/PrivacyInfo.xcprivacy" "$APP_REQUIRED_REASON_GRAPH"
  expect_reader "the shipped Share extension manifest reads back as the script's pinned share graph" \
    "$repo_root/apps/ios/RelayiumShare/PrivacyInfo.xcprivacy" "$SHARE_REQUIRED_REASON_GRAPH"

  # And a manifest built here from the same four entries, in a DIFFERENT order,
  # reads back identically — which is what the canonical sort is for. Without
  # it, a reordering Xcode or a future editor introduced would be reported as a
  # changed graph.
  expect_reader 'entry order in the plist does not change the graph' \
    "$(write_manifest reordered \
       "$disk_space_entry$boot_time_entry$user_defaults_entry$file_timestamp_entry")" \
    "$APP_REQUIRED_REASON_GRAPH"

  # ── and rejects every way it must reject ───────────────────────────────────

  expect_reader_differs() {
    local label="$1" name="$2" body="$3" file actual
    file="$(write_manifest "$name" "$body")"
    if ! actual="$(required_reason_graph_of "$file")"; then
      # A refusal is also a rejection, and an acceptable one: the caller turns
      # both into a finding. What must never happen is a match.
      ok "$label"
      return
    fi
    if [ "$actual" = "$APP_REQUIRED_REASON_GRAPH" ]; then
      bad "$label" 'the mutated manifest read back as the pinned app graph'
    else
      ok "$label"
    fi
  }

  # 1. A missing category. This is the shape the Disk Space correction was
  #    about: the app calls `statfs`, and a manifest without E174.1 is an
  #    upload rejection Apple raises rather than a defect anything local sees.
  no_disk_space_body="$user_defaults_entry$file_timestamp_entry$boot_time_entry"
  expect_reader_differs 'a manifest missing the Disk Space entry does not match' \
    no-disk-space "$no_disk_space_body"
  expect_reader_differs 'a manifest missing the file-timestamp entry does not match' \
    no-file-timestamp "$user_defaults_entry$boot_time_entry$disk_space_entry"

  # 2. A wrong reason code under a correct category — the category is right,
  #    the claim under it is not, and every presence check ever written passes.
  wrong_reason_body="$no_disk_space_body$(
    api_entry NSPrivacyAccessedAPICategoryDiskSpace E174.2)"
  expect_reader_differs 'a Disk Space entry with the wrong reason code does not match' \
    wrong-reason "$wrong_reason_body"
  expect_reader_differs 'a Disk Space entry with an extra reason code does not match' \
    extra-reason "$no_disk_space_body$(
      api_entry NSPrivacyAccessedAPICategoryDiskSpace E174.1 85F4.1)"

  # 3. An unexpected category — over-declaring, which is a false public
  #    statement in the direction people assume is safe.
  over_declared_body="$real_app_body$(
    api_entry NSPrivacyAccessedAPICategoryActiveKeyboards 3EC4.1)"
  expect_reader_differs 'a manifest declaring an API the source does not use does not match' \
    over-declared "$over_declared_body"

  # 4. Duplicates, which are what a set-shaped reader collapses into a graph
  #    that compares EQUAL to the correct one. Both spellings are covered: the
  #    same category twice, and the same reason twice inside one entry.
  duplicate_category_body="$real_app_body$disk_space_entry"
  expect_reader_differs 'a manifest declaring Disk Space twice does not match' \
    duplicate-category "$duplicate_category_body"
  expect_reader_differs 'a manifest repeating a reason inside one entry does not match' \
    duplicate-reason "$no_disk_space_body$(
      api_entry NSPrivacyAccessedAPICategoryDiskSpace E174.1 E174.1)"
  # The same category twice with DIFFERENT reasons — a first-wins reader keeps
  # the correct one and never sees the second.
  expect_reader_differs 'a manifest declaring one category twice with different reasons does not match' \
    duplicate-category-disagreeing "$real_app_body$(
      api_entry NSPrivacyAccessedAPICategoryDiskSpace E174.2)"

  # 5. An empty list, which is what a manifest stripped of its declarations
  #    looks like — and what a reader returning "" on failure would produce.
  expect_reader_differs 'a manifest declaring nothing does not match' declares-nothing ''

  # 6. The extension shipping the APP's manifest. Present, valid, lint-clean
  #    and wrong: this is the failure a per-bundle presence check cannot see.
  app_graph_in_share_slot="$(write_manifest app-graph-in-share-slot "$real_app_body")"
  if [ "$(required_reason_graph_of "$app_graph_in_share_slot")" = "$SHARE_REQUIRED_REASON_GRAPH" ]; then
    bad 'the app manifest does not read back as the extension graph' 'the two graphs compared equal'
  else
    ok 'the app manifest does not read back as the extension graph'
  fi

  # ── unreadable input is a refusal, never an empty graph ────────────────────
  #
  # This is the one that would be silent. A reader that answered "" for a
  # malformed manifest would compare unequal to the pinned graph and produce the
  # right verdict for the wrong reason — until the day somebody pinned an empty
  # expectation, or read the message and looked for a wrong category that was
  # never there.
  expect_reader_refuses() {
    local label="$1" file="$2" actual
    if actual="$(required_reason_graph_of "$file")"; then
      bad "$label" "the reader returned '$actual' instead of refusing"
    else
      ok "$label"
    fi
  }

  no_api_key="$manifests/no-api-key.xcprivacy"
  cat >"$no_api_key" <<'MANIFEST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>NSPrivacyTracking</key>
	<false/>
</dict>
</plist>
MANIFEST
  expect_reader_refuses 'a manifest with no NSPrivacyAccessedAPITypes key is refused' "$no_api_key"

  untyped_entry="$manifests/untyped-entry.xcprivacy"
  cat >"$untyped_entry" <<'MANIFEST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>NSPrivacyAccessedAPITypes</key>
	<array>
		<dict>
			<key>NSPrivacyAccessedAPITypeReasons</key>
			<array>
				<string>E174.1</string>
			</array>
		</dict>
	</array>
</dict>
</plist>
MANIFEST
  expect_reader_refuses 'an entry naming no category is refused' "$untyped_entry"

  reasonless_entry="$manifests/reasonless-entry.xcprivacy"
  cat >"$reasonless_entry" <<'MANIFEST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>NSPrivacyAccessedAPITypes</key>
	<array>
		<dict>
			<key>NSPrivacyAccessedAPIType</key>
			<string>NSPrivacyAccessedAPICategoryDiskSpace</string>
		</dict>
	</array>
</dict>
</plist>
MANIFEST
  expect_reader_refuses 'an entry declaring no reasons array is refused' "$reasonless_entry"

  not_a_plist="$manifests/not-a-plist.xcprivacy"
  printf 'this is not a plist\n' >"$not_a_plist"
  expect_reader_refuses 'a manifest that is not a plist at all is refused' "$not_a_plist"

  expect_reader_refuses 'a manifest that is not there is refused' \
    "$manifests/does-not-exist.xcprivacy"

  # ── and the caller turns every one of those into a finding ─────────────────
  #
  # The reader's return value is not the gate; `expect_required_reason_graph` is.
  # Each case below is run through it with the script's own reporting helpers
  # replaced by counters, so the assertion is that a finding was RAISED rather
  # than that a comparison came out unequal somewhere upstream.

  expect_checker() {
    local label="$1" file="$2" expected="$3" want_failures="$4" before
    before="$lifted_failures"
    expect_required_reason_graph "$file" "$expected" 'fixture' >/dev/null 2>&1
    local raised=$((lifted_failures - before))
    if [ "$want_failures" -eq 0 ] && [ "$raised" -eq 0 ]; then
      ok "$label"
    elif [ "$want_failures" -ne 0 ] && [ "$raised" -gt 0 ]; then
      ok "$label"
    else
      bad "$label" "it raised $raised finding(s)"
    fi
  }

  # The correct manifest raises nothing — a checker that failed everything would
  # be as useless as one that failed nothing, and would pass every case below.
  expect_checker 'the shipped app manifest raises no finding against the pinned app graph' \
    "$repo_root/apps/ios/Relayium/PrivacyInfo.xcprivacy" "$APP_REQUIRED_REASON_GRAPH" 0
  expect_checker 'the shipped Share manifest raises no finding against the pinned share graph' \
    "$repo_root/apps/ios/RelayiumShare/PrivacyInfo.xcprivacy" "$SHARE_REQUIRED_REASON_GRAPH" 0

  # Each reuses the fixture its reader case already wrote, by the name that case
  # gave it — which is only safe because those names are distinct.
  expect_checker 'a missing Disk Space declaration is a finding' \
    "$manifests/no-disk-space.xcprivacy" "$APP_REQUIRED_REASON_GRAPH" 1
  expect_checker 'a wrong Disk Space reason code is a finding' \
    "$manifests/wrong-reason.xcprivacy" "$APP_REQUIRED_REASON_GRAPH" 1
  expect_checker 'an over-declared category is a finding' \
    "$manifests/over-declared.xcprivacy" "$APP_REQUIRED_REASON_GRAPH" 1
  expect_checker 'a duplicated category is a finding' \
    "$manifests/duplicate-category.xcprivacy" "$APP_REQUIRED_REASON_GRAPH" 1
  expect_checker 'an extension shipping the app manifest is a finding' \
    "$app_graph_in_share_slot" "$SHARE_REQUIRED_REASON_GRAPH" 1
  expect_checker 'a manifest that is not a valid plist is a finding' \
    "$not_a_plist" "$APP_REQUIRED_REASON_GRAPH" 1
  expect_checker 'a manifest that is absent is a finding' \
    "$manifests/does-not-exist.xcprivacy" "$APP_REQUIRED_REASON_GRAPH" 1
  expect_checker 'a manifest with no required-reason key at all is a finding' \
    "$no_api_key" "$APP_REQUIRED_REASON_GRAPH" 1

  unset -f fail_check pass_check
fi

# ─────────────────────────────────────────────────────────────────────────────
# Part 1d — the collected-data graph reader, driven adversarially
# ─────────────────────────────────────────────────────────────────────────────
#
# The same treatment as Part 1c, for the OTHER half of a privacy manifest — and
# the half where a mistake is quieter. A wrong required-reason graph is refused
# at upload by Apple, so somebody finds out. A wrong collected-data list uploads
# cleanly, becomes the App Store privacy label, and is then read as a promise by
# people deciding whether to install. Nothing outside this script checks it.
#
# So the two functions are LIFTED out of the shipped script rather than
# reimplemented, and driven against manifests built here. `plutil_path` is
# already lifted above and is reused.

eval "$(sed -n '/^collected_data_graph_of() {/,/^}/p' "$script_under_test")"
eval "$(sed -n '/^expect_collected_data_graph() {/,/^}/p' "$script_under_test")"
eval "$(sed -n "/^readonly APP_COLLECTED_DATA_GRAPH=/,/NSPrivacyCollectedDataTypeUserID.*'\$/p" \
  "$script_under_test")"
eval "$(sed -n "/^readonly SHARE_COLLECTED_DATA_GRAPH=/p" "$script_under_test")"

collected_lifted_ok=1
for lifted in collected_data_graph_of expect_collected_data_graph; do
  if ! declare -f "$lifted" >/dev/null 2>&1; then
    bad "$lifted can be lifted out of the script" 'the function was not found or did not parse'
    collected_lifted_ok=0
  fi
done
if [ -z "${APP_COLLECTED_DATA_GRAPH:-}" ]; then
  bad 'the pinned collected-data graph can be lifted out of the script' \
      'the constant did not parse'
  collected_lifted_ok=0
fi
# `SHARE_COLLECTED_DATA_GRAPH` is deliberately EMPTY, so "did it parse" cannot be
# asked by testing it for emptiness — an unparsed variable and a correctly
# parsed one look identical. `declare -p` distinguishes set-and-empty from
# never-set, which is the only question worth asking here.
if ! declare -p SHARE_COLLECTED_DATA_GRAPH >/dev/null 2>&1; then
  bad 'the pinned empty Share collected-data graph can be lifted out of the script' \
      'the constant did not parse'
  collected_lifted_ok=0
fi

if [ "$collected_lifted_ok" -eq 1 ]; then
  collected_failures=0
  # shellcheck disable=SC2329
  fail_check() { collected_failures=$((collected_failures + 1)); }
  # shellcheck disable=SC2329
  pass_check() { :; }

  collected="$work/collected-fixtures"
  mkdir -p "$collected"

  # One `NSPrivacyCollectedDataTypes` entry. Purposes are variadic so a
  # duplicated or extra purpose can be expressed, and the two booleans are
  # parameters so a wrong `Linked` is a fixture rather than a hand-written file.
  collected_entry() {
    local type="$1" linked="$2" tracking="$3"; shift 3
    local purpose
    printf '\t\t<dict>\n'
    printf '\t\t\t<key>NSPrivacyCollectedDataType</key>\n\t\t\t<string>%s</string>\n' "$type"
    printf '\t\t\t<key>NSPrivacyCollectedDataTypeLinked</key>\n\t\t\t<%s/>\n' "$linked"
    printf '\t\t\t<key>NSPrivacyCollectedDataTypeTracking</key>\n\t\t\t<%s/>\n' "$tracking"
    printf '\t\t\t<key>NSPrivacyCollectedDataTypePurposes</key>\n\t\t\t<array>\n'
    for purpose in "$@"; do printf '\t\t\t\t<string>%s</string>\n' "$purpose"; done
    printf '\t\t\t</array>\n\t\t</dict>'
  }

  # A whole manifest around a body of collected-data entries. The required-reason
  # list is a fixed valid one: this section is not about that half, and an empty
  # one would make these fixtures fail a DIFFERENT check than the one under test.
  write_collected_manifest() {
    local path="$collected/$1.xcprivacy" body="$2"
    cat >"$path" <<MANIFEST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>NSPrivacyTracking</key>
	<false/>
	<key>NSPrivacyTrackingDomains</key>
	<array/>
	<key>NSPrivacyCollectedDataTypes</key>
	<array>
$body
	</array>
	<key>NSPrivacyAccessedAPITypes</key>
	<array>
		<dict>
			<key>NSPrivacyAccessedAPIType</key>
			<string>NSPrivacyAccessedAPICategoryFileTimestamp</string>
			<key>NSPrivacyAccessedAPITypeReasons</key>
			<array>
				<string>DDA9.1</string>
			</array>
		</dict>
	</array>
</dict>
</plist>
MANIFEST
    printf '%s' "$path"
  }

  readonly FUNCTIONALITY='NSPrivacyCollectedDataTypePurposeAppFunctionality'
  readonly ANALYTICS='NSPrivacyCollectedDataTypePurposeAnalytics'

  name_entry="$(collected_entry NSPrivacyCollectedDataTypeName true false "$FUNCTIONALITY")"
  email_entry="$(collected_entry NSPrivacyCollectedDataTypeEmailAddress true false "$FUNCTIONALITY")"
  purchase_entry="$(collected_entry NSPrivacyCollectedDataTypePurchaseHistory true false "$FUNCTIONALITY")"
  user_id_entry="$(collected_entry NSPrivacyCollectedDataTypeUserID true false "$FUNCTIONALITY")"
  usage_entry="$(collected_entry NSPrivacyCollectedDataTypeOtherUsageData true false "$FUNCTIONALITY")"
  aggregate_entry="$(collected_entry NSPrivacyCollectedDataTypeProductInteraction false false "$ANALYTICS")"
  real_collected_body="$name_entry$email_entry$purchase_entry$user_id_entry$usage_entry$aggregate_entry"

  # ── the reader accepts what it must accept ─────────────────────────────────
  #
  # First and most importantly: the manifest this repository actually ships must
  # produce exactly the graph the script pins, and the extension's must produce
  # the empty one. This is what ties the two halves together —
  # `IOSPrivacyManifestTests` derives the same set from the source that justifies
  # each entry, the script states it independently, and if those two statements
  # ever disagree the operator's run fails on a correct build.
  expect_collected_reader() {
    local label="$1" file="$2" expected="$3" actual
    if ! actual="$(collected_data_graph_of "$file")"; then
      bad "$label" "the reader refused $file"
      return
    fi
    if [ "$actual" = "$expected" ]; then
      ok "$label"
    else
      bad "$label" "read '$actual', expected '$expected'"
    fi
  }

  expect_collected_reader "the shipped iOS app manifest reads back as the script's pinned collected-data graph" \
    "$repo_root/apps/ios/Relayium/PrivacyInfo.xcprivacy" "$APP_COLLECTED_DATA_GRAPH"
  expect_collected_reader "the shipped Share extension manifest reads back as collecting nothing" \
    "$repo_root/apps/ios/RelayiumShare/PrivacyInfo.xcprivacy" "$SHARE_COLLECTED_DATA_GRAPH"

  # Entry order in the plist does not change the graph, which is what the
  # canonical sort is for.
  expect_collected_reader 'entry order in the plist does not change the collected-data graph' \
    "$(write_collected_manifest reordered \
       "$aggregate_entry$user_id_entry$name_entry$usage_entry$email_entry$purchase_entry")" \
    "$APP_COLLECTED_DATA_GRAPH"

  # ── and rejects every way it must reject ───────────────────────────────────

  expect_collected_differs() {
    local label="$1" name="$2" body="$3" file actual
    file="$(write_collected_manifest "$name" "$body")"
    if ! actual="$(collected_data_graph_of "$file")"; then
      # A refusal is also a rejection, and an acceptable one: the caller turns
      # both into a finding. What must never happen is a match.
      ok "$label"
      return
    fi
    if [ "$actual" = "$APP_COLLECTED_DATA_GRAPH" ]; then
      bad "$label" 'the mutated manifest read back as the pinned app collected-data graph'
    else
      ok "$label"
    fi
  }

  # 1. A MISSING type. The label would under-report what the app collects, which
  #    is the direction Apple treats as a misrepresentation rather than caution.
  without_usage_body="$name_entry$email_entry$purchase_entry$user_id_entry$aggregate_entry"
  expect_collected_differs 'a manifest missing the metering declaration does not match' \
    no-usage "$without_usage_body"
  expect_collected_differs 'a manifest missing the aggregate declaration does not match' \
    no-aggregate "$name_entry$email_entry$purchase_entry$user_id_entry$usage_entry"

  # 2. An ADDED type, and specifically the one this platform must never declare.
  #    `DeviceID` is what the macOS manifest carries and what a parity-minded
  #    edit would copy across; iOS reaches neither producer, so declaring it
  #    would publish a claim that this app sends a device identifier.
  expect_collected_differs 'a manifest declaring DeviceID does not match' \
    device-id "$real_collected_body$(
      collected_entry NSPrivacyCollectedDataTypeDeviceID true false "$FUNCTIONALITY")"

  # 3. DUPLICATES, which are what a set-shaped reader collapses into a graph
  #    that compares EQUAL to the correct one.
  expect_collected_differs 'a manifest declaring a type twice does not match' \
    duplicate-type "$real_collected_body$user_id_entry"
  expect_collected_differs 'a manifest repeating a purpose inside one entry does not match' \
    duplicate-purpose "$name_entry$email_entry$purchase_entry$user_id_entry$aggregate_entry$(
      collected_entry NSPrivacyCollectedDataTypeOtherUsageData true false \
        "$FUNCTIONALITY" "$FUNCTIONALITY")"
  # The same type twice with DIFFERENT flags — a first-wins reader keeps the
  # correct one and never sees the second.
  expect_collected_differs 'a manifest declaring one type twice with different flags does not match' \
    duplicate-type-disagreeing "$real_collected_body$(
      collected_entry NSPrivacyCollectedDataTypeUserID false false "$ANALYTICS")"

  # 4. A WRONG LINKED flag. The type, the purpose and the count are all correct,
  #    and the claim under them is not: an unlinked aggregate declared as linked
  #    over-reports, and a linked identifier declared as unlinked under-reports.
  #    Neither is visible to any check that only reads the type list.
  expect_collected_differs 'the aggregate declared as linked to the account does not match' \
    aggregate-linked "$name_entry$email_entry$purchase_entry$user_id_entry$usage_entry$(
      collected_entry NSPrivacyCollectedDataTypeProductInteraction true false "$ANALYTICS")"
  expect_collected_differs 'an account-linked type declared as unlinked does not match' \
    email-unlinked "$name_entry$purchase_entry$user_id_entry$usage_entry$aggregate_entry$(
      collected_entry NSPrivacyCollectedDataTypeEmailAddress false false "$FUNCTIONALITY")"

  # 5. A WRONG TRACKING flag, which is the single most consequential bit in the
  #    file: `true` here would put Relayium in App Tracking Transparency's scope.
  expect_collected_differs 'a type declared as tracking does not match' \
    email-tracking "$name_entry$purchase_entry$user_id_entry$usage_entry$aggregate_entry$(
      collected_entry NSPrivacyCollectedDataTypeEmailAddress true true "$FUNCTIONALITY")"

  # 6. A WRONG PURPOSE, in both directions: Analytics attached to something
  #    account-linked, and App Functionality attached to the aggregate.
  expect_collected_differs 'a linked type declared for Analytics does not match' \
    name-analytics "$email_entry$purchase_entry$user_id_entry$usage_entry$aggregate_entry$(
      collected_entry NSPrivacyCollectedDataTypeName true false "$ANALYTICS")"
  expect_collected_differs 'the aggregate declared for App Functionality does not match' \
    aggregate-functionality "$name_entry$email_entry$purchase_entry$user_id_entry$usage_entry$(
      collected_entry NSPrivacyCollectedDataTypeProductInteraction false false "$FUNCTIONALITY")"
  expect_collected_differs 'an entry carrying a second purpose nobody justified does not match' \
    extra-purpose "$email_entry$purchase_entry$user_id_entry$usage_entry$aggregate_entry$(
      collected_entry NSPrivacyCollectedDataTypeName true false "$FUNCTIONALITY" "$ANALYTICS")"

  # 7. An EMPTY list where the app's is expected — what a manifest stripped of
  #    its declarations looks like, and what a reader returning "" on failure
  #    would produce.
  expect_collected_differs 'an app manifest declaring nothing does not match' \
    app-declares-nothing ''

  # ── the appex direction: empty is a CLAIM, not the absence of one ──────────
  #
  # The classic failure is not a missing manifest but the APP's manifest ending
  # up in the extension: present, valid, lint-clean, and declaring six types that
  # process cannot collect. A per-bundle presence check cannot see it.
  app_collected_in_share_slot="$(write_collected_manifest app-collected-in-share-slot \
    "$real_collected_body")"
  if [ "$(collected_data_graph_of "$app_collected_in_share_slot")" \
       = "$SHARE_COLLECTED_DATA_GRAPH" ]; then
    bad 'the app collected-data graph does not read back as the extension one' \
        'the two graphs compared equal'
  else
    ok 'the app collected-data graph does not read back as the extension one'
  fi

  # And a single stray entry in the appex, which is the smaller and likelier
  # version of the same mistake.
  expect_collected_appex_differs() {
    local label="$1" file="$2" actual
    if ! actual="$(collected_data_graph_of "$file")"; then
      ok "$label"
      return
    fi
    if [ "$actual" = "$SHARE_COLLECTED_DATA_GRAPH" ]; then
      bad "$label" 'a non-empty appex manifest read back as collecting nothing'
    else
      ok "$label"
    fi
  }
  expect_collected_appex_differs 'an appex declaring one collected type does not read back as empty' \
    "$(write_collected_manifest appex-one-entry "$email_entry")"

  # ── unreadable input is a refusal, never an empty graph ────────────────────
  #
  # This is the one that would be silent, and it is sharper here than in Part 1c
  # because the extension's CORRECT answer is the empty string. A reader that
  # answered "" for a malformed manifest would make an unparseable appex
  # manifest PASS the emptiness check — the wrong verdict, not merely the right
  # verdict for the wrong reason.
  expect_collected_refuses() {
    local label="$1" file="$2" actual
    if actual="$(collected_data_graph_of "$file")"; then
      bad "$label" "the reader returned '$actual' instead of refusing"
    else
      ok "$label"
    fi
  }

  no_collected_key="$collected/no-collected-key.xcprivacy"
  cat >"$no_collected_key" <<'MANIFEST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>NSPrivacyTracking</key>
	<false/>
</dict>
</plist>
MANIFEST
  expect_collected_refuses 'a manifest with no NSPrivacyCollectedDataTypes key is refused' \
    "$no_collected_key"

  # An entry naming no type. The refusal matters most for the APPEX: without it
  # this element would be discarded and the manifest would read as empty.
  untyped_collected="$collected/untyped-collected.xcprivacy"
  cat >"$untyped_collected" <<'MANIFEST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>NSPrivacyCollectedDataTypes</key>
	<array>
		<dict>
			<key>NSPrivacyCollectedDataTypeLinked</key>
			<true/>
			<key>NSPrivacyCollectedDataTypeTracking</key>
			<false/>
			<key>NSPrivacyCollectedDataTypePurposes</key>
			<array>
				<string>NSPrivacyCollectedDataTypePurposeAppFunctionality</string>
			</array>
		</dict>
	</array>
</dict>
</plist>
MANIFEST
  expect_collected_refuses 'a collected-data entry naming no type is refused' "$untyped_collected"

  # An entry with no `Linked` key at all. Apple defines four keys per entry, and
  # an omitted flag is a malformed entry rather than a truthful one with a
  # default — a reader that supplied `false` would publish "not linked to you"
  # over a file that never said so.
  no_linked_key="$collected/no-linked-key.xcprivacy"
  cat >"$no_linked_key" <<'MANIFEST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>NSPrivacyCollectedDataTypes</key>
	<array>
		<dict>
			<key>NSPrivacyCollectedDataType</key>
			<string>NSPrivacyCollectedDataTypeEmailAddress</string>
			<key>NSPrivacyCollectedDataTypeTracking</key>
			<false/>
			<key>NSPrivacyCollectedDataTypePurposes</key>
			<array>
				<string>NSPrivacyCollectedDataTypePurposeAppFunctionality</string>
			</array>
		</dict>
	</array>
</dict>
</plist>
MANIFEST
  expect_collected_refuses 'a collected-data entry with no Linked flag is refused' "$no_linked_key"

  # A `Linked` value that is not a boolean. `plutil` extracts it happily; the
  # shape check is what rejects it, and without that the graph would carry a
  # string where a flag belongs.
  non_boolean_linked="$collected/non-boolean-linked.xcprivacy"
  cat >"$non_boolean_linked" <<'MANIFEST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>NSPrivacyCollectedDataTypes</key>
	<array>
		<dict>
			<key>NSPrivacyCollectedDataType</key>
			<string>NSPrivacyCollectedDataTypeEmailAddress</string>
			<key>NSPrivacyCollectedDataTypeLinked</key>
			<string>yes</string>
			<key>NSPrivacyCollectedDataTypeTracking</key>
			<false/>
			<key>NSPrivacyCollectedDataTypePurposes</key>
			<array>
				<string>NSPrivacyCollectedDataTypePurposeAppFunctionality</string>
			</array>
		</dict>
	</array>
</dict>
</plist>
MANIFEST
  expect_collected_refuses 'a non-boolean Linked flag is refused' "$non_boolean_linked"

  # An entry declaring a type with NO purpose. App Store Connect requires at
  # least one, so this is a rejected submission rather than something to
  # describe — and `?? empty` would have turned it into a silent pass.
  purposeless="$collected/purposeless.xcprivacy"
  cat >"$purposeless" <<'MANIFEST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>NSPrivacyCollectedDataTypes</key>
	<array>
		<dict>
			<key>NSPrivacyCollectedDataType</key>
			<string>NSPrivacyCollectedDataTypeEmailAddress</string>
			<key>NSPrivacyCollectedDataTypeLinked</key>
			<true/>
			<key>NSPrivacyCollectedDataTypeTracking</key>
			<false/>
			<key>NSPrivacyCollectedDataTypePurposes</key>
			<array/>
		</dict>
	</array>
</dict>
</plist>
MANIFEST
  expect_collected_refuses 'a collected-data entry with an empty purpose list is refused' \
    "$purposeless"

  collected_not_a_plist="$collected/not-a-plist.xcprivacy"
  printf 'this is not a plist\n' >"$collected_not_a_plist"
  expect_collected_refuses 'a collected-data manifest that is not a plist is refused' \
    "$collected_not_a_plist"

  expect_collected_refuses 'a collected-data manifest that is not there is refused' \
    "$collected/does-not-exist.xcprivacy"

  # ── and the caller turns every one of those into a finding ─────────────────
  #
  # The reader's return value is not the gate; `expect_collected_data_graph` is.

  expect_collected_checker() {
    local label="$1" file="$2" expected="$3" want_failures="$4" before
    before="$collected_failures"
    expect_collected_data_graph "$file" "$expected" 'fixture' >/dev/null 2>&1
    local raised=$((collected_failures - before))
    if [ "$want_failures" -eq 0 ] && [ "$raised" -eq 0 ]; then
      ok "$label"
    elif [ "$want_failures" -ne 0 ] && [ "$raised" -gt 0 ]; then
      ok "$label"
    else
      bad "$label" "it raised $raised finding(s)"
    fi
  }

  # The correct manifests raise nothing. A checker that failed everything would
  # be as useless as one that failed nothing, and would pass every case below.
  expect_collected_checker 'the shipped app manifest raises no collected-data finding' \
    "$repo_root/apps/ios/Relayium/PrivacyInfo.xcprivacy" "$APP_COLLECTED_DATA_GRAPH" 0
  expect_collected_checker 'the shipped Share manifest raises no collected-data finding' \
    "$repo_root/apps/ios/RelayiumShare/PrivacyInfo.xcprivacy" "$SHARE_COLLECTED_DATA_GRAPH" 0

  # Each reuses the fixture its reader case already wrote, by the name that case
  # gave it — which is only safe because those names are distinct.
  expect_collected_checker 'a missing collected-data type is a finding' \
    "$collected/no-usage.xcprivacy" "$APP_COLLECTED_DATA_GRAPH" 1
  expect_collected_checker 'a declared DeviceID is a finding' \
    "$collected/device-id.xcprivacy" "$APP_COLLECTED_DATA_GRAPH" 1
  expect_collected_checker 'a duplicated collected-data type is a finding' \
    "$collected/duplicate-type.xcprivacy" "$APP_COLLECTED_DATA_GRAPH" 1
  expect_collected_checker 'a wrong Linked flag is a finding' \
    "$collected/aggregate-linked.xcprivacy" "$APP_COLLECTED_DATA_GRAPH" 1
  expect_collected_checker 'a tracking declaration is a finding' \
    "$collected/email-tracking.xcprivacy" "$APP_COLLECTED_DATA_GRAPH" 1
  expect_collected_checker 'a wrong purpose is a finding' \
    "$collected/name-analytics.xcprivacy" "$APP_COLLECTED_DATA_GRAPH" 1
  expect_collected_checker 'an extension shipping the app collected-data list is a finding' \
    "$app_collected_in_share_slot" "$SHARE_COLLECTED_DATA_GRAPH" 1
  expect_collected_checker 'an extension declaring one collected type is a finding' \
    "$collected/appex-one-entry.xcprivacy" "$SHARE_COLLECTED_DATA_GRAPH" 1
  expect_collected_checker 'a malformed collected-data entry is a finding' \
    "$no_linked_key" "$APP_COLLECTED_DATA_GRAPH" 1
  # And the same malformed file measured against the EMPTY expectation, which is
  # the appex's. This is the case a reader returning "" on failure would pass.
  expect_collected_checker 'a malformed appex manifest is a finding rather than an empty match' \
    "$no_linked_key" "$SHARE_COLLECTED_DATA_GRAPH" 1
  expect_collected_checker 'a collected-data manifest that is absent is a finding' \
    "$collected/does-not-exist.xcprivacy" "$APP_COLLECTED_DATA_GRAPH" 1
  expect_collected_checker 'a manifest with no collected-data key at all is a finding' \
    "$no_collected_key" "$SHARE_COLLECTED_DATA_GRAPH" 1

  unset -f fail_check pass_check
fi

# ─────────────────────────────────────────────────────────────────────────────
# Part 2 — the script actually runs, and actually refuses
# ─────────────────────────────────────────────────────────────────────────────

mkdir -p "$work/bin"

cat >"$work/bin/xcodebuild" <<'STUB'
#!/usr/bin/env bash
# Records its argv and answers the questions the script asks. It compiles,
# links and signs NOTHING — the suite asserts what was ASKED FOR, and a stub
# that produced a plausible signed artifact would be claiming to have signed
# something.
#
# STUB_ARCHIVE_MODE selects how far the script is allowed to get:
#
#   fail     (default) `archive` exits 65, so the run stops at the archive and
#            the suite reads back the archive argv and the preserved log.
#   succeed  `archive` creates the EXACT directory it was handed in
#            -archivePath — an empty one, with no products, no binary and no
#            signature — and exits 0. That satisfies the script's `[ -d
#            "$archive_path" ]` guard and nothing else, which is the point: it
#            buys exactly one more stage, the export, and the export then fails
#            so the suite can read back its argv and log. The verification half
#            beyond the export needs a real signed IPA and is never entered.
#
# `-exportArchive` always fails. There is no mode in which this stub claims to
# have exported a signed application.
log="${STUB_ARGV_LOG:-/dev/null}"
{ printf 'xcodebuild'; for a in "$@"; do printf '\t%s' "$a"; done; printf '\n'; } >>"$log"

for a in "$@"; do
  if [ "$a" = "-version" ]; then
    printf 'Xcode %s\nBuild version %s\n' "${STUB_XCODE_VERSION:-26.3}" "${STUB_XCODE_BUILD:-17C529}"
    exit 0
  fi
done

target=''
want_target=0
show_settings=0
for a in "$@"; do
  if [ "$want_target" -eq 1 ]; then target="$a"; want_target=0; continue; fi
  case "$a" in
    -target) want_target=1 ;;
    -showBuildSettings) show_settings=1 ;;
  esac
done

if [ "$show_settings" -eq 1 ]; then
  case "$target" in
    Relayium)
      bundle="${STUB_APP_BUNDLE:-com.relayium.mac}"
      profile="${STUB_APP_PROFILE:-Relayium iOS Universal App Store}" ;;
    RelayiumShare)
      bundle="${STUB_SHARE_BUNDLE:-com.relayium.mac.ShareIOS}"
      profile="${STUB_SHARE_PROFILE:-Relayium iOS Share Extension App Store}" ;;
    *) printf 'stub xcodebuild: unknown target %s\n' "$target" >&2; exit 1 ;;
  esac
  printf 'Build settings for action build and target %s:\n' "$target"
  printf '    CODE_SIGN_STYLE = %s\n' "${STUB_SIGN_STYLE:-Manual}"
  printf '    CURRENT_PROJECT_VERSION = %s\n' "${STUB_BUILD:-6}"
  printf '    DEVELOPMENT_TEAM = %s\n' "${STUB_TEAM:-7PVYUG4YQS}"
  printf '    MARKETING_VERSION = %s\n' "${STUB_MARKETING:-0.3.0}"
  printf '    PRODUCT_BUNDLE_IDENTIFIER = %s\n' "$bundle"
  printf '    PROVISIONING_PROFILE_SPECIFIER = %s\n' "$profile"
  exit 0
fi

# `-exportArchive` is decided before `archive`: the export invocation carries an
# -archivePath too, and answering it as an archive would be the wrong stage.
want_archive_path=0
archive_path=''
do_archive=0
do_export=0
for a in "$@"; do
  if [ "$want_archive_path" -eq 1 ]; then archive_path="$a"; want_archive_path=0; continue; fi
  case "$a" in
    -archivePath) want_archive_path=1 ;;
    -exportArchive) do_export=1 ;;
    archive) do_archive=1 ;;
  esac
done

if [ "$do_export" -eq 1 ]; then
  printf 'stub xcodebuild: this suite never exports\n'
  exit 70
fi

if [ "$do_archive" -eq 1 ]; then
  if [ "${STUB_ARCHIVE_MODE:-fail}" = 'succeed' ]; then
    if [ -z "$archive_path" ]; then
      printf 'stub xcodebuild: archive without -archivePath\n' >&2
      exit 66
    fi
    # Only the path xcodebuild was ASKED to create, and only an empty directory.
    mkdir -p "$archive_path" || exit 66
    printf 'stub xcodebuild: created an empty %s; nothing was compiled or signed\n' "$archive_path"
    exit 0
  fi
  printf 'stub xcodebuild: this suite never archives\n'
  exit 65
fi
exit 0
STUB

cat >"$work/bin/xcrun" <<'STUB'
#!/usr/bin/env bash
if [ "${1:-}" = "--sdk" ] && [ "${2:-}" = "iphoneos" ] && [ "${3:-}" = "--show-sdk-version" ]; then
  printf '%s\n' "${STUB_IPHONEOS_SDK:-26.2}"
  exit 0
fi
printf 'stub xcrun: unsupported invocation: %s\n' "$*" >&2
exit 1
STUB
chmod +x "$work/bin/xcodebuild" "$work/bin/xcrun"

export GIT_CONFIG_GLOBAL=/dev/null
export GIT_CONFIG_SYSTEM=/dev/null
export GIT_AUTHOR_NAME='candidate test'
export GIT_AUTHOR_EMAIL='candidate-test@example.invalid'
export GIT_COMMITTER_NAME='candidate test'
export GIT_COMMITTER_EMAIL='candidate-test@example.invalid'

# One pristine fixture, copied per case. A repository with the script inside it,
# an iOS project directory the script only needs to find, and a bare remote the
# branch tracks.
pristine="$work/pristine"
mkdir -p "$pristine/repo/scripts" "$pristine/repo/docs" \
  "$pristine/repo/apps/ios/Relayium.xcodeproj" \
  "$pristine/repo/apps/ios/Relayium" "$pristine/repo/apps/ios/RelayiumShare"
cp "$script_under_test" "$pristine/repo/scripts/$script_name"
# The real validator and the real packet, so the executed cases below exercise
# the actual gate rather than a stand-in that always agrees.
cp "$repo_root/scripts/ios-app-store-metadata-validate.mjs" "$pristine/repo/scripts/"
cp "$repo_root/docs/app-store-metadata-ios.json" "$pristine/repo/docs/"
# And the two manifests the validator cross-checks the packet against. It
# resolves them from ITS OWN directory — `<validator>/../apps/ios/...` — so a
# fixture holding only the packet makes the real gate reject a packet that is
# correct, and every case after the gate fails for a reason none of them is
# about. These are copies of the shipped files rather than stand-ins, for the
# same reason the packet is: a fixture that always agrees proves nothing.
cp "$repo_root/apps/ios/Relayium/PrivacyInfo.xcprivacy" "$pristine/repo/apps/ios/Relayium/"
cp "$repo_root/apps/ios/RelayiumShare/PrivacyInfo.xcprivacy" "$pristine/repo/apps/ios/RelayiumShare/"
printf '// fixture\n' >"$pristine/repo/apps/ios/Relayium.xcodeproj/project.pbxproj"
printf 'fixture\n' >"$pristine/repo/README.md"
git init -q --initial-branch=main "$pristine/repo" >/dev/null 2>&1
git init -q --bare "$pristine/origin.git" >/dev/null 2>&1
git -C "$pristine/repo" add -A >/dev/null 2>&1
git -C "$pristine/repo" commit -q -m 'fixture' >/dev/null 2>&1
git -C "$pristine/repo" remote add origin "$pristine/origin.git" >/dev/null 2>&1
git -C "$pristine/repo" push -q --set-upstream origin main >/dev/null 2>&1

if ! git -C "$pristine/repo" rev-parse '@{upstream}' >/dev/null 2>&1; then
  printf 'could not build the fixture repository\n' >&2
  exit 2
fi

# The fixture has to be able to PASS the metadata gate, not merely to contain a
# packet. The gate is the real validator reading real files out of the fixture
# tree, so every file it learns to cross-check has to be copied in above — and
# when one is not, the gate rejects a correct packet and each executed case
# after it refuses for that reason instead of its own, which is a suite that
# reports dozens of failures and names the cause of none of them.
#
# Asserting the fixture here turns that cascade into one line naming the file.
# It is a fixture-construction failure, so it exits 2 like the checks above
# rather than counting as a test failure: nothing about the script under test
# has been established yet either way.
metadata_probe=''
if ! metadata_probe="$(node "$pristine/repo/scripts/ios-app-store-metadata-validate.mjs" \
    --packet "$pristine/repo/docs/app-store-metadata-ios.json" \
    --expect-version 0.3.0 --quiet 2>&1)"; then
  printf 'the fixture repository cannot pass the metadata gate, so no case beyond it would test what it claims:\n%s\n' \
    "$metadata_probe" >&2
  exit 2
fi

case_number=0
fixture=''
short_sha=''
new_fixture() {
  case_number=$((case_number + 1))
  fixture="$work/case-$case_number"
  cp -R "$pristine" "$fixture"
  mkdir -p "$fixture/out"
  short_sha="$(git -C "$fixture/repo" rev-parse --short=8 HEAD)"
}

# Several cases below edit a TRACKED file in the fixture — the metadata packet
# or its validator. The clean-worktree and upstream checks run BEFORE the gate
# those cases are aiming at, so an uncommitted edit would be refused one section
# too early and the case would pass for the wrong reason. This commits the edit
# and pushes it, then re-reads the short SHA the artifact root has to name.
commit_fixture() {
  # `cp -R` copies the pristine remote URL too, which still points into the
  # pristine tree. Pushing there would advance a remote every later case copies
  # from, so the very first pushing case would break every one after it.
  git -C "$fixture/repo" remote set-url origin "$fixture/origin.git" >/dev/null 2>&1
  git -C "$fixture/repo" add -A >/dev/null 2>&1
  git -C "$fixture/repo" commit -q -m 'fixture edit' >/dev/null 2>&1
  git -C "$fixture/repo" push -q origin main >/dev/null 2>&1
  short_sha="$(git -C "$fixture/repo" rev-parse --short=8 HEAD)"
}

now_iso() { date -u '+%Y-%m-%dT%H:%M:%SZ'; }
iso_offset() { date -u -r "$(( $(date -u '+%s') + $1 ))" '+%Y-%m-%dT%H:%M:%SZ'; }

reset_stubs() {
  export STUB_XCODE_VERSION='26.3'
  export STUB_XCODE_BUILD='17C529'
  export STUB_IPHONEOS_SDK='26.2'
  export STUB_MARKETING='0.3.0'
  export STUB_BUILD='6'
  export STUB_TEAM='7PVYUG4YQS'
  export STUB_SIGN_STYLE='Manual'
  export STUB_APP_BUNDLE='com.relayium.mac'
  export STUB_SHARE_BUNDLE='com.relayium.mac.ShareIOS'
  export STUB_APP_PROFILE='Relayium iOS Universal App Store'
  export STUB_SHARE_PROFILE='Relayium iOS Share Extension App Store'
  export STUB_ARCHIVE_MODE='fail'
}

# Runs the copy of the script inside the current fixture. Returns its exit
# status; its output is left in the fixture for the assertions.
run_candidate() {
  STUB_ARGV_LOG="$fixture/xcodebuild-argv.log" \
  PATH="$work/bin:$PATH" \
    "$fixture/repo/scripts/$script_name" "$@" \
      >"$fixture/stdout.log" 2>"$fixture/stderr.log"
}

# The five options, with every value correct, so a case can override exactly
# one of them. A global array rather than a here-string, because this suite runs
# under the bash macOS ships and that one has no `mapfile`.
DEFAULT_ARGS=()
set_default_args() {
  DEFAULT_ARGS=(
    --marketing-version 0.3.0
    --build 6
    --readback-highest-build 5
    --readback-observed-at "$(now_iso)"
    --artifact-root "$fixture/out/relayium-ios-0.3.0-6-$short_sha"
  )
}

expect_refusal() {
  local label="$1" expected_status="$2" expected_message="$3"; shift 3
  local status
  run_candidate "$@" && status=0 || status=$?
  if [ "$status" -ne "$expected_status" ]; then
    bad "$label" "exited $status, expected $expected_status; stderr: $(tail -3 "$fixture/stderr.log" | tr '\n' ' ')"
    return
  fi
  if ! grep -qF -e "$expected_message" "$fixture/stderr.log"; then
    bad "$label" "exit $status was right but the message did not mention '$expected_message'; stderr: $(tail -3 "$fixture/stderr.log" | tr '\n' ' ')"
    return
  fi
  ok "$label"
}

readonly REFUSED=2
readonly BUILD_FAILED=3

# ── the read-back acknowledgement ────────────────────────────────────────────

reset_stubs

new_fixture
set_default_args
expect_refusal 'no arguments at all is refused' "$REFUSED" 'missing --marketing-version'

new_fixture
set_default_args
expect_refusal 'an unknown argument is refused' "$REFUSED" 'unknown argument' "${DEFAULT_ARGS[@]}" --upload

new_fixture
set_default_args
expect_refusal 'a missing read-back timestamp is refused' "$REFUSED" 'missing --readback-observed-at' \
  --marketing-version 0.3.0 --build 6 --readback-highest-build 5 \
  --artifact-root "$fixture/out/relayium-ios-0.3.0-6-$short_sha"

new_fixture
expect_refusal 'a build that is not the next free one is refused' "$REFUSED" 'is not the next free build' \
  --marketing-version 0.3.0 --build 9 --readback-highest-build 5 \
  --readback-observed-at "$(now_iso)" \
  --artifact-root "$fixture/out/relayium-ios-0.3.0-9-$short_sha"

new_fixture
expect_refusal 'a build below the observed highest is refused' "$REFUSED" 'is not the next free build' \
  --marketing-version 0.3.0 --build 3 --readback-highest-build 5 \
  --readback-observed-at "$(now_iso)" \
  --artifact-root "$fixture/out/relayium-ios-0.3.0-3-$short_sha"

new_fixture
expect_refusal 'a stale read-back is refused' "$REFUSED" 'older than' \
  --marketing-version 0.3.0 --build 6 --readback-highest-build 5 \
  --readback-observed-at "$(iso_offset -100000)" \
  --artifact-root "$fixture/out/relayium-ios-0.3.0-6-$short_sha"

new_fixture
expect_refusal 'a read-back in the future is refused' "$REFUSED" 'is in the future' \
  --marketing-version 0.3.0 --build 6 --readback-highest-build 5 \
  --readback-observed-at "$(iso_offset 7200)" \
  --artifact-root "$fixture/out/relayium-ios-0.3.0-6-$short_sha"

new_fixture
expect_refusal 'a malformed read-back timestamp is refused' "$REFUSED" 'is not a UTC timestamp' \
  --marketing-version 0.3.0 --build 6 --readback-highest-build 5 \
  --readback-observed-at 'yesterday' \
  --artifact-root "$fixture/out/relayium-ios-0.3.0-6-$short_sha"

new_fixture
expect_refusal 'a non-numeric build is refused' "$REFUSED" 'is not a canonical positive decimal build number' \
  --marketing-version 0.3.0 --build '6; rm -rf /' --readback-highest-build 5 \
  --readback-observed-at "$(now_iso)" \
  --artifact-root "$fixture/out/relayium-ios-0.3.0-6-$short_sha"

# ── the build numbers must be CANONICAL decimal ──────────────────────────────
#
# A leading zero is the interesting input, because `^[0-9]+$` accepts it and
# then `$(( ))` reads it as octal. Each of these cases must land on the
# documented refusal — exit 2 with a message naming the option and the shape it
# wants — rather than on the shell's own arithmetic diagnostic, which exits 1
# and belongs to none of the three documented outcome classes.

new_fixture
expect_refusal 'a --build with a leading zero is refused' "$REFUSED" 'is not a canonical positive decimal build number' \
  --marketing-version 0.3.0 --build '08' --readback-highest-build 7 \
  --readback-observed-at "$(now_iso)" \
  --artifact-root "$fixture/out/relayium-ios-0.3.0-8-$short_sha"
if [ -e "$fixture/out/relayium-ios-0.3.0-8-$short_sha" ]; then
  bad 'a leading-zero build creates nothing' 'the artifact root exists'
else
  ok 'a leading-zero build creates nothing'
fi

new_fixture
expect_refusal 'a --build of 0 is refused' "$REFUSED" 'is not a canonical positive decimal build number' \
  --marketing-version 0.3.0 --build 0 --readback-highest-build 0 \
  --readback-observed-at "$(now_iso)" \
  --artifact-root "$fixture/out/relayium-ios-0.3.0-0-$short_sha"

new_fixture
expect_refusal 'a --readback-highest-build with a leading zero is refused' "$REFUSED" \
  'is not a canonical nonnegative decimal build number' \
  --marketing-version 0.3.0 --build 9 --readback-highest-build '08' \
  --readback-observed-at "$(now_iso)" \
  --artifact-root "$fixture/out/relayium-ios-0.3.0-9-$short_sha"

# `010` is the quiet one: it is VALID octal, evaluates to 8, and an operator who
# wrote it meaning ten would have had `--build 9` accepted as the next free
# build. It must be refused on its shape, before any arithmetic sees it.
new_fixture
expect_refusal 'a --readback-highest-build of 010 is refused rather than read as octal 8' "$REFUSED" \
  'is not a canonical nonnegative decimal build number' \
  --marketing-version 0.3.0 --build 9 --readback-highest-build '010' \
  --readback-observed-at "$(now_iso)" \
  --artifact-root "$fixture/out/relayium-ios-0.3.0-9-$short_sha"

# ── the next-free check must not be fixed-width arithmetic ───────────────────
#
# `10#` fixes the BASE. It does not fix the WIDTH, and bash arithmetic is signed
# machine integers that wrap silently instead of reporting overflow. So a build
# number of 2^64 + 1 is canonical decimal — every regex above accepts it — and
# `$((10#18446744073709551617))` evaluates to 1, which is exactly the next free
# build after a highest of 0. Under the arithmetic comparison this input passed
# the read-back cross-check and walked on to the toolchain and repository
# checks, carrying a build number App Store Connect could never accept. It must
# be refused here, with the same exit 2 and the same next-free message as any
# other disagreeing pair.
new_fixture
expect_refusal 'a build that wraps 64-bit arithmetic is refused rather than read as its remainder' \
  "$REFUSED" 'is not the next free build' \
  --marketing-version 0.3.0 --build 18446744073709551617 --readback-highest-build 0 \
  --readback-observed-at "$(now_iso)" \
  --artifact-root "$fixture/out/relayium-ios-0.3.0-wrap-$short_sha"
if grep -qF -e 'the next free build is 1' "$fixture/stderr.log"; then
  ok 'the wrapping build is refused against the exact next free build'
else
  bad 'the wrapping build is refused against the exact next free build' \
    "the message did not name 1 as the next free build; stderr: $(tail -3 "$fixture/stderr.log" | tr '\n' ' ')"
fi
if [ -e "$fixture/out/relayium-ios-0.3.0-wrap-$short_sha" ]; then
  bad 'a wrapping build creates nothing' 'the artifact root exists'
else
  ok 'a wrapping build creates nothing'
fi

# The same input one step up: a highest consumed build past 2^64 wraps to 0, so
# `--build 1` would have looked like its successor.
new_fixture
expect_refusal 'a highest consumed build that wraps 64-bit arithmetic is refused' \
  "$REFUSED" 'is not the next free build' \
  --marketing-version 0.3.0 --build 1 --readback-highest-build 18446744073709551616 \
  --readback-observed-at "$(now_iso)" \
  --artifact-root "$fixture/out/relayium-ios-0.3.0-wraphigh-$short_sha"

# Carrying across a run of 9s is where a digit-at-a-time increment goes wrong if
# it goes wrong at all: 999 + 1 must be 1000, not 9910 or 100.
new_fixture
expect_refusal 'a carry across a run of 9s is refused against the right successor' \
  "$REFUSED" 'the next free build is 1000' \
  --marketing-version 0.3.0 --build 9910 --readback-highest-build 999 \
  --readback-observed-at "$(now_iso)" \
  --artifact-root "$fixture/out/relayium-ios-0.3.0-9910-$short_sha"

# And the successor itself must be ACCEPTED by this check — a cross-check that
# refuses the correct pair is as broken as one that accepts a wrong one. It gets
# refused later, on the project's declared numbers, which is proof it got past
# the read-back section.
new_fixture
expect_refusal 'the correct successor across a carry passes the read-back check' "$REFUSED" \
  'CURRENT_PROJECT_VERSION' \
  --marketing-version 0.3.0 --build 1000 --readback-highest-build 999 \
  --readback-observed-at "$(now_iso)" \
  --artifact-root "$fixture/out/relayium-ios-0.3.0-1000-$short_sha"

# An attestation ABOVE the observed floor still has to reach the project's own
# numbers to be refused: the floor is a lower bound on one operand, not a second
# opinion about the pair. `7`/`8` is a consistent pair the project does not
# declare, so it must get past this section and die on CURRENT_PROJECT_VERSION.
new_fixture
expect_refusal 'a highest consumed build above the floor passes the shape check' "$REFUSED" \
  'CURRENT_PROJECT_VERSION' \
  --marketing-version 0.3.0 --build 8 --readback-highest-build 7 \
  --readback-observed-at "$(now_iso)" \
  --artifact-root "$fixture/out/relayium-ios-0.3.0-8-$short_sha"

# 0 consumed builds used to be a real state of the record this candidate
# targeted, and it is not a real state of THIS one: the universal-purchase
# record's iOS TestFlight was read back holding a Validated `0.1.0 (4)`, so four
# numbers are already gone. An attestation of 0 is now the shape of the exact
# migration error the floor exists for — reading the retired record's history,
# or none at all — and it is refused before anything is built.
#
# The pair is internally consistent (`0` then `1`), so it clears the successor
# check and can only be caught here. That is the point: the successor check
# compares the operator against themselves, and this compares them against
# something observed.
new_fixture
expect_refusal 'a highest consumed build of 0 is refused against the observed floor' "$REFUSED" \
  'is below 4' \
  --marketing-version 0.3.0 --build 1 --readback-highest-build 0 \
  --readback-observed-at "$(now_iso)" \
  --artifact-root "$fixture/out/relayium-ios-0.3.0-1-$short_sha"

# One below the floor, which is the off-by-one a `<=` would let through.
new_fixture
expect_refusal 'a highest consumed build one below the floor is refused' "$REFUSED" \
  'is below 4' \
  --marketing-version 0.3.0 --build 4 --readback-highest-build 3 \
  --readback-observed-at "$(now_iso)" \
  --artifact-root "$fixture/out/relayium-ios-0.3.0-4-$short_sha"

# And the floor itself is ACCEPTED. A gate that refuses the exact observed value
# is as broken as one that accepts a value below it. Proved by pushing the
# toolchain out of range instead: that check runs strictly AFTER the read-back
# section, so reaching it is proof this pair got through.
new_fixture
STUB_XCODE_VERSION='27.0'
expect_refusal 'the observed floor itself passes the read-back section' "$REFUSED" \
  'not the required major' \
  --marketing-version 0.3.0 --build 5 --readback-highest-build 4 \
  --readback-observed-at "$(now_iso)" \
  --artifact-root "$fixture/out/relayium-ios-0.3.0-5-$short_sha"
reset_stubs

new_fixture
expect_refusal 'a marketing version that is not x.y.z is refused' "$REFUSED" 'is not an x.y.z marketing version' \
  --marketing-version 'latest' --build 6 --readback-highest-build 5 \
  --readback-observed-at "$(now_iso)" \
  --artifact-root "$fixture/out/relayium-ios-latest-6-$short_sha"

# ── the toolchain ────────────────────────────────────────────────────────────

new_fixture
STUB_XCODE_VERSION='27.0'
set_default_args
expect_refusal 'a newer Xcode major is refused' "$REFUSED" 'not the required major' "${DEFAULT_ARGS[@]}"
reset_stubs

new_fixture
STUB_XCODE_VERSION='16.4'
set_default_args
expect_refusal 'an older Xcode major is refused' "$REFUSED" 'not the required major' "${DEFAULT_ARGS[@]}"
reset_stubs

new_fixture
STUB_IPHONEOS_SDK='18.5'
set_default_args
expect_refusal 'an iphoneos SDK below the floor is refused' "$REFUSED" 'below the App Store minimum' "${DEFAULT_ARGS[@]}"
reset_stubs

# ── repository state ─────────────────────────────────────────────────────────

new_fixture
printf 'uncommitted\n' >>"$fixture/repo/README.md"
set_default_args
expect_refusal 'a dirty worktree is refused' "$REFUSED" 'worktree is not clean' "${DEFAULT_ARGS[@]}"

new_fixture
printf 'untracked\n' >"$fixture/repo/stray.txt"
set_default_args
expect_refusal 'an untracked file is refused' "$REFUSED" 'worktree is not clean' "${DEFAULT_ARGS[@]}"

new_fixture
git -C "$fixture/repo" branch --unset-upstream >/dev/null 2>&1
set_default_args
expect_refusal 'a branch with no upstream is refused' "$REFUSED" 'has no upstream' "${DEFAULT_ARGS[@]}"

new_fixture
printf 'local only\n' >>"$fixture/repo/README.md"
git -C "$fixture/repo" commit -qam 'unpushed' >/dev/null 2>&1
short_sha="$(git -C "$fixture/repo" rev-parse --short=8 HEAD)"
set_default_args
expect_refusal 'a commit that is not pushed is refused' "$REFUSED" 'differs from upstream' "${DEFAULT_ARGS[@]}"

# ── the artifact root ────────────────────────────────────────────────────────

new_fixture
expect_refusal 'a relative artifact root is refused' "$REFUSED" 'must be absolute' \
  --marketing-version 0.3.0 --build 6 --readback-highest-build 5 \
  --readback-observed-at "$(now_iso)" --artifact-root "out/relayium-$short_sha"

new_fixture
expect_refusal 'an artifact root not naming the commit is refused' "$REFUSED" 'must end with the candidate commit' \
  --marketing-version 0.3.0 --build 6 --readback-highest-build 5 \
  --readback-observed-at "$(now_iso)" --artifact-root "$fixture/out/relayium-ios-candidate"

new_fixture
mkdir -p "$fixture/out/relayium-ios-0.3.0-6-$short_sha"
printf 'the operator kept something here\n' >"$fixture/out/relayium-ios-0.3.0-6-$short_sha/keep.txt"
set_default_args
expect_refusal 'an artifact root that already exists is refused' "$REFUSED" 'already exists' "${DEFAULT_ARGS[@]}"
if [ -f "$fixture/out/relayium-ios-0.3.0-6-$short_sha/keep.txt" ]; then
  ok 'the refused, pre-existing caller directory is left untouched'
else
  bad 'the refused, pre-existing caller directory is left untouched' 'the file inside it is gone'
fi

new_fixture
expect_refusal 'an artifact root inside the repository is refused' "$REFUSED" 'inside the repository' \
  --marketing-version 0.3.0 --build 6 --readback-highest-build 5 \
  --readback-observed-at "$(now_iso)" --artifact-root "$fixture/repo/build-$short_sha"

new_fixture
expect_refusal 'an artifact root directly under / is refused' "$REFUSED" 'directly under /' \
  --marketing-version 0.3.0 --build 6 --readback-highest-build 5 \
  --readback-observed-at "$(now_iso)" --artifact-root "/relayium-ios-$short_sha"

new_fixture
expect_refusal 'an artifact root directly in the home directory is refused' "$REFUSED" 'would write directly into' \
  --marketing-version 0.3.0 --build 6 --readback-highest-build 5 \
  --readback-observed-at "$(now_iso)" --artifact-root "$HOME/relayium-ios-candidate-$short_sha"
if [ -e "$HOME/relayium-ios-candidate-$short_sha" ]; then
  bad 'a refused artifact root is never created' "$HOME/relayium-ios-candidate-$short_sha exists"
else
  ok 'a refused artifact root is never created'
fi

# ── the App Store metadata packet ────────────────────────────────────────────
#
# The gate sits between the repository-state checks and the project settings, so
# each case below asserts BOTH the refusal and where in the ladder it happened:
# `xcodebuild -version` has run by then, `-showBuildSettings` has not, no archive
# was attempted, and — because the section precedes the artifact root — nothing
# was created on disk at all.

metadata_stopped_before_the_project() {
  local label="$1" argv_log="$fixture/xcodebuild-argv.log"
  if grep -qF -- '-showBuildSettings' "$argv_log" 2>/dev/null; then
    bad "$label" 'the project settings were read, so the metadata gate ran too late'
    return
  fi
  if grep -qF -e "$(printf '\tarchive')" "$argv_log" 2>/dev/null; then
    bad "$label" 'an archive was attempted after a rejected metadata packet'
    return
  fi
  if [ -e "$fixture/out/relayium-ios-0.3.0-6-$short_sha" ]; then
    bad "$label" 'the artifact root was created before the packet was accepted'
    return
  fi
  ok "$label"
}

# `commit_fixture` steps a case PAST the clean-worktree and upstream checks so it
# can reach the gate after them. That is only legitimate if it leaves the fixture
# genuinely clean and genuinely pushed: a helper that left either broken would
# make every metadata case below refuse one section too early and pass for the
# wrong reason, silently retiring the gate they exist to test. So the helper's
# own postcondition is asserted once, directly.
new_fixture
rm -f "$fixture/repo/docs/app-store-metadata-ios.json"
commit_fixture
if [ -n "$(git -C "$fixture/repo" status --porcelain)" ]; then
  bad 'commit_fixture leaves the fixture clean' 'the worktree is still dirty'
elif [ "$(git -C "$fixture/repo" rev-parse HEAD)" != "$(git -C "$fixture/repo" rev-parse '@{upstream}')" ]; then
  bad 'commit_fixture leaves the fixture clean' 'HEAD does not match its upstream'
else
  ok 'commit_fixture leaves the fixture clean and pushed, so the checks it steps past still hold'
fi
set_default_args
expect_refusal 'a missing metadata packet is refused' "$REFUSED" \
  'App Store metadata packet is missing' "${DEFAULT_ARGS[@]}"
metadata_stopped_before_the_project 'a missing packet stops before the project is read'

new_fixture
rm -f "$fixture/repo/scripts/ios-app-store-metadata-validate.mjs"
commit_fixture
set_default_args
expect_refusal 'a missing metadata validator is refused' "$REFUSED" \
  'App Store metadata validator is missing' "${DEFAULT_ARGS[@]}"

# One real finding, produced the way a careless edit produces it: a subtitle
# four characters over Apple's limit. The script must refuse on the validator's
# non-zero status rather than printing the finding and carrying on.
new_fixture
packet="$fixture/repo/docs/app-store-metadata-ios.json"
node -e '
  const fs = require("fs");
  const path = process.argv[1];
  const packet = JSON.parse(fs.readFileSync(path, "utf8"));
  packet.storefront["en-US"].subtitle = "End-to-end encrypted device transfer";
  fs.writeFileSync(path, JSON.stringify(packet, null, 2) + "\n");
' "$packet"
commit_fixture
set_default_args
expect_refusal 'a packet App Store Connect would refuse stops the candidate' "$REFUSED" \
  'metadata packet is not submittable' "${DEFAULT_ARGS[@]}"
metadata_stopped_before_the_project 'a rejected packet stops before the project is read'
if grep -qF "over Apple's limit of 30" "$fixture/stdout.log" "$fixture/stderr.log"; then
  ok "the validator's own finding reaches the operator"
else
  bad "the validator's own finding reaches the operator" \
      "neither log mentions the length finding"
fi

# The packet describes a marketing version; the candidate names one. A packet
# whose What's New was drafted for another version is a false public statement
# about the build being archived, and only the cross-check catches it.
new_fixture
packet="$fixture/repo/docs/app-store-metadata-ios.json"
node -e '
  const fs = require("fs");
  const path = process.argv[1];
  const packet = JSON.parse(fs.readFileSync(path, "utf8"));
  packet.record.marketingVersion = "0.4.0";
  fs.writeFileSync(path, JSON.stringify(packet, null, 2) + "\n");
' "$packet"
commit_fixture
set_default_args
expect_refusal 'a packet drafted for another version stops the candidate' "$REFUSED" \
  'metadata packet is not submittable' "${DEFAULT_ARGS[@]}"

new_fixture
set_default_args
run_candidate "${DEFAULT_ARGS[@]}" >/dev/null 2>&1
if grep -qF 'metadata packet sha256' "$fixture/stdout.log"; then
  ok 'an accepted packet is checksummed into the run'
else
  bad 'an accepted packet is checksummed into the run' \
      "stdout did not report the packet checksum"
fi

# ── the project must already declare this candidate ──────────────────────────

new_fixture
STUB_MARKETING='0.2.9'
set_default_args
expect_refusal 'a project marketing version that disagrees is refused' "$REFUSED" "MARKETING_VERSION = '0.2.9'" "${DEFAULT_ARGS[@]}"
if [ -e "$fixture/out/relayium-ios-0.3.0-6-$short_sha/Relayium.xcarchive" ]; then
  bad 'a project mismatch stops before the archive' 'an archive path exists'
else
  ok 'a project mismatch stops before the archive'
fi
reset_stubs

new_fixture
STUB_BUILD='5'
set_default_args
expect_refusal 'a project build number that disagrees is refused' "$REFUSED" "CURRENT_PROJECT_VERSION = '5'" "${DEFAULT_ARGS[@]}"
reset_stubs

new_fixture
STUB_TEAM='AAAAAAAAAA'
set_default_args
expect_refusal 'a project team that is not the pinned one is refused' "$REFUSED" "DEVELOPMENT_TEAM = 'AAAAAAAAAA'" "${DEFAULT_ARGS[@]}"
reset_stubs

new_fixture
STUB_SIGN_STYLE='Automatic'
set_default_args
expect_refusal 'automatic Release signing is refused' "$REFUSED" "CODE_SIGN_STYLE = 'Automatic'" "${DEFAULT_ARGS[@]}"
reset_stubs

new_fixture
STUB_APP_PROFILE='Relayium iOS Development'
set_default_args
expect_refusal 'a provisioning profile that is not the pinned one is refused' "$REFUSED" 'PROVISIONING_PROFILE_SPECIFIER' "${DEFAULT_ARGS[@]}"
reset_stubs

# The MACOS Share extension's identifier, which is the plausible wrong answer
# now that both platforms sit under `com.relayium.mac`: it is a legal suffix of
# the app's bundle id, it exists in this team, and it is already provisioned —
# so nothing but this check distinguishes it from the iOS appex.
new_fixture
STUB_SHARE_BUNDLE='com.relayium.mac.Share'
set_default_args
expect_refusal "the macOS Share extension's bundle identifier is refused for the iOS appex" "$REFUSED" \
  'PRODUCT_BUNDLE_IDENTIFIER' "${DEFAULT_ARGS[@]}"
reset_stubs

# And the retired separate-record identity, in both bundles. This is the exact
# regression the universal-purchase migration can suffer — a project reverted to
# `com.relayium.app` still builds, still signs if the old profile is installed,
# and uploads to a record that holds none of this app's subscription products.
new_fixture
STUB_APP_BUNDLE='com.relayium.app'
set_default_args
expect_refusal 'the retired com.relayium.app app identity is refused' "$REFUSED" \
  'PRODUCT_BUNDLE_IDENTIFIER' "${DEFAULT_ARGS[@]}"
reset_stubs

new_fixture
STUB_SHARE_BUNDLE='com.relayium.app.share'
set_default_args
expect_refusal 'the retired com.relayium.app.share extension identity is refused' "$REFUSED" \
  'PRODUCT_BUNDLE_IDENTIFIER' "${DEFAULT_ARGS[@]}"
reset_stubs

# The pre-migration profile name, which is the half a partial revert leaves
# behind: the bundle ids move and the specifier does not.
new_fixture
STUB_SHARE_PROFILE='Relayium Share Extension App Store'
set_default_args
expect_refusal 'the pre-migration share profile name is refused' "$REFUSED" \
  'PROVISIONING_PROFILE_SPECIFIER' "${DEFAULT_ARGS[@]}"
reset_stubs

# ── every precondition satisfied: what the script actually asks xcodebuild ───

new_fixture
artifact="$fixture/out/relayium-ios-0.3.0-6-$short_sha"
set_default_args
run_candidate "${DEFAULT_ARGS[@]}" && status=0 || status=$?

if [ "$status" -ne "$BUILD_FAILED" ]; then
  bad 'a complete contract reaches the archive and reports its failure' \
      "exited $status, expected $BUILD_FAILED; stderr: $(tail -3 "$fixture/stderr.log" | tr '\n' ' ')"
else
  ok 'a complete contract reaches the archive and reports its failure'
fi

archive_log="$artifact/logs/archive.log"
if [ -s "$archive_log" ]; then
  ok 'the failed archive log is preserved'
else
  bad 'the failed archive log is preserved' "$archive_log is missing or empty"
fi

argv_log="$fixture/xcodebuild-argv.log"
archive_argv="$(grep -F "	archive" "$argv_log" | tail -1)"
check_argv() {
  local needle="$1" label="$2"
  if printf '%s' "$archive_argv" | grep -qF -e "$needle"; then
    ok "the archive invocation passes $label"
  else
    bad "the archive invocation passes $label" "argv was: $archive_argv"
  fi
}
check_argv '-scheme	Relayium' 'the Relayium scheme'
check_argv '-configuration	Release' 'the Release configuration'
check_argv '-destination	generic/platform=iOS' 'a generic iOS destination'
check_argv "-archivePath	$artifact/Relayium.xcarchive" 'an archive path inside the artifact root'
check_argv "-derivedDataPath	$artifact/DerivedData" 'derived data inside the artifact root'

if printf '%s' "$archive_argv" | grep -qF -- '-allowProvisioningUpdates'; then
  bad 'the archive never allows provisioning updates' "argv was: $archive_argv"
else
  ok 'the archive never allows provisioning updates'
fi

if grep -qF -- '-exportArchive' "$argv_log"; then
  bad 'a failed archive is never exported' 'the export ran after the archive failed'
else
  ok 'a failed archive is never exported'
fi

# ── the generated export options ─────────────────────────────────────────────

export_options="$artifact/ExportOptions.plist"
if [ ! -f "$export_options" ]; then
  bad 'the export options are generated inside the artifact root' "$export_options is missing"
else
  ok 'the export options are generated inside the artifact root'
  expect_option() {
    local key="$1" expected="$2" actual
    actual="$(plutil -extract "$key" raw -o - "$export_options" 2>/dev/null)"
    if [ "$actual" = "$expected" ]; then
      ok "the export options set $key = $expected"
    else
      bad "the export options set $key = $expected" "it is '$actual'"
    fi
  }
  expect_option destination export
  expect_option method app-store-connect
  expect_option teamID 7PVYUG4YQS
  expect_option signingStyle manual
  expect_option manageAppVersionAndBuildNumber false
  expect_option 'provisioningProfiles.com\.relayium\.mac' 'Relayium iOS Universal App Store'
  expect_option 'provisioningProfiles.com\.relayium\.mac\.ShareIOS' 'Relayium iOS Share Extension App Store'

  if grep -q 'upload' "$export_options"; then
    bad 'the export options name no upload destination' "$export_options mentions upload"
  else
    ok 'the export options name no upload destination'
  fi
fi

# ── one stage further: the archive succeeds, and the export is read back ─────
#
# The case above stops at the archive, so the export invocation — the one that
# carries the options plist and, if anybody ever added it, the flag that lets
# Xcode mutate provisioning profiles — was never observed at all. Here the stub
# creates the exact `.xcarchive` directory it was handed and reports success,
# which is the minimum that gets the script past its `[ -d "$archive_path" ]`
# guard, and the export then fails.
#
# The archive the stub leaves is empty: no products, no binary, no signature.
# That is deliberate and is the boundary of this suite. Nothing here fabricates
# a signed export, so the run cannot and must not reach the verification half,
# whose every check reads a real signed bundle.

new_fixture
export_artifact="$fixture/out/relayium-ios-0.3.0-6-$short_sha"
STUB_ARCHIVE_MODE='succeed'
set_default_args
run_candidate "${DEFAULT_ARGS[@]}" && status=0 || status=$?
reset_stubs

if [ "$status" -ne "$BUILD_FAILED" ]; then
  bad 'a successful archive reaches the export and reports its failure' \
      "exited $status, expected $BUILD_FAILED; stderr: $(tail -3 "$fixture/stderr.log" | tr '\n' ' ')"
elif ! grep -qF -- '-exportArchive failed' "$fixture/stderr.log"; then
  bad 'a successful archive reaches the export and reports its failure' \
      "exit 3 was right but the message did not name the export; stderr: $(tail -3 "$fixture/stderr.log" | tr '\n' ' ')"
else
  ok 'a successful archive reaches the export and reports its failure'
fi

if [ -d "$export_artifact/Relayium.xcarchive" ]; then
  ok 'the archive the script asked for is the one the stub created'
else
  bad 'the archive the script asked for is the one the stub created' \
      "$export_artifact/Relayium.xcarchive is missing"
fi

export_log="$export_artifact/logs/export.log"
if [ -s "$export_log" ]; then
  ok 'the failed export log is preserved'
else
  bad 'the failed export log is preserved' "$export_log is missing or empty"
fi

# The whole argv, compared for EQUALITY rather than scanned for needles. An
# export is four arguments, they are all known, and equality is the only form of
# this assertion that also fails on a fifth one nobody meant to add.
export_argv_log="$fixture/xcodebuild-argv.log"
actual_export_argv="$(awk -F'\t' '$2 == "-exportArchive" { line = $0 } END { print line }' "$export_argv_log")"
export_invocations="$(awk -F'\t' '$2 == "-exportArchive" { n++ } END { print n + 0 }' "$export_argv_log")"
expected_export_argv="$(printf 'xcodebuild\t-exportArchive\t-archivePath\t%s\t-exportOptionsPlist\t%s\t-exportPath\t%s' \
  "$export_artifact/Relayium.xcarchive" \
  "$export_artifact/ExportOptions.plist" \
  "$export_artifact/export")"

if [ "$export_invocations" -ne 1 ]; then
  bad 'the export is invoked exactly once' "it ran $export_invocations time(s)"
else
  ok 'the export is invoked exactly once'
fi

if [ "$actual_export_argv" = "$expected_export_argv" ]; then
  ok 'the export invocation is exactly -exportArchive, the archive, the generated options and the export path'
else
  bad 'the export invocation is exactly -exportArchive, the archive, the generated options and the export path' \
      "argv was: $actual_export_argv"
fi

if printf '%s' "$actual_export_argv" | grep -qF -- '-allowProvisioningUpdates'; then
  bad 'the export never allows provisioning updates' "argv was: $actual_export_argv"
else
  ok 'the export never allows provisioning updates'
fi

# The failed export must stop the run there. `verify/` is the first thing the
# verification half creates, so its absence is what proves the run did not walk
# into checks that need a signed artifact this suite never produced.
if [ -e "$export_artifact/verify" ]; then
  bad 'a failed export never enters verification' "$export_artifact/verify exists"
else
  ok 'a failed export never enters verification'
fi

if [ -e "$export_artifact/export/Relayium.ipa" ]; then
  bad 'no IPA is fabricated' "$export_artifact/export/Relayium.ipa exists"
else
  ok 'no IPA is fabricated'
fi

# ─────────────────────────────────────────────────────────────────────────────

printf '\n'
if [ "$failures" -eq 0 ]; then
  printf 'all checks passed (%s mutations, %s executed cases)\n' "$mutation_number" "$case_number"
  exit 0
fi
printf '%s check(s) failed\n' "$failures"
exit 1
