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
[ -x "$script_under_test" ] || { printf '%s is not executable\n' "$script_under_test" >&2; exit 2; }

case "$(uname -s)" in
  Darwin) ;;
  *) printf 'this suite requires macOS (plutil, and the xcodebuild wrapper it tests)\n' >&2; exit 2 ;;
esac
command -v plutil >/dev/null 2>&1 || { printf 'plutil is required\n' >&2; exit 2; }
command -v git >/dev/null 2>&1 || { printf 'git is required\n' >&2; exit 2; }

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
^readonly APP_BUNDLE_ID='com\.relayium\.app'$	the pinned app bundle identifier is gone
^readonly SHARE_BUNDLE_ID='com\.relayium\.app\.share'$	the pinned Share extension bundle identifier is gone
^readonly APP_PROFILE='Relayium iOS App Store'$	the pinned app provisioning profile is gone
^readonly SHARE_PROFILE='Relayium Share Extension App Store'$	the pinned Share provisioning profile is gone
^readonly EXPORT_DESTINATION='export'$	the export could target upload instead of a local export
^readonly EXPORT_METHOD='app-store-connect'$	the export method is no longer the App Store one
^readonly EXPORT_SIGNING_STYLE='manual'$	signing could fall back to automatic, which resolves profiles Xcode chooses
^readonly REQUIRED_XCODE_MAJOR=26$	the required Xcode major is gone; Apple rejects uploads from another major
^readonly MIN_IPHONEOS_SDK_MAJOR=26$	the iphoneos SDK floor is gone
^readonly READBACK_MAX_AGE_SECONDS=	a read-back of any age would authorize a build number
^next_free_build="\$\(decimal_increment "\$readback_highest_build"\)"$	the two supplied build numbers are no longer cross-checked
^if \[ "\$build_number" != "\$next_free_build" \]; then$	the next-free comparison is gone, or has gone back to fixed-width shell arithmetic that wraps
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
		<string>com.relayium.app</string>
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
	<string>7PVYUG4YQS.com.relayium.app</string>
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
    "$fixtures/archive-info.plist" 'com.relayium.app' raw ApplicationProperties CFBundleIdentifier
  expect_path 'a nested archive path reaches the build number' \
    "$fixtures/archive-info.plist" '6' raw ApplicationProperties CFBundleVersion
  expect_path 'a nested archive path reaches the signing identity' \
    "$fixtures/archive-info.plist" 'Apple Distribution: Example (7PVYUG4YQS)' raw ApplicationProperties SigningIdentity
  expect_path 'a dotted entitlement name is read as one literal key' \
    "$fixtures/entitlements.plist" '["Default"]' json 'com.apple.developer.applesignin'
  expect_path 'a dotted App Group entitlement is read as one literal key' \
    "$fixtures/entitlements.plist" '["group.com.relayium.app"]' json 'com.apple.security.application-groups'
  expect_path 'an undotted entitlement name still works' \
    "$fixtures/entitlements.plist" '7PVYUG4YQS.com.relayium.app' raw 'application-identifier'

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
      bundle="${STUB_APP_BUNDLE:-com.relayium.app}"
      profile="${STUB_APP_PROFILE:-Relayium iOS App Store}" ;;
    RelayiumShare)
      bundle="${STUB_SHARE_BUNDLE:-com.relayium.app.share}"
      profile="${STUB_SHARE_PROFILE:-Relayium Share Extension App Store}" ;;
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
mkdir -p "$pristine/repo/scripts" "$pristine/repo/apps/ios/Relayium.xcodeproj"
cp "$script_under_test" "$pristine/repo/scripts/$script_name"
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
  export STUB_APP_BUNDLE='com.relayium.app'
  export STUB_SHARE_BUNDLE='com.relayium.app.share'
  export STUB_APP_PROFILE='Relayium iOS App Store'
  export STUB_SHARE_PROFILE='Relayium Share Extension App Store'
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

# 0 consumed builds is a real record state — nothing has been accepted yet — so
# it must pass the shape check and be refused later, on the project's numbers,
# rather than here.
new_fixture
expect_refusal 'a highest consumed build of 0 passes the shape check' "$REFUSED" \
  'CURRENT_PROJECT_VERSION' \
  --marketing-version 0.3.0 --build 1 --readback-highest-build 0 \
  --readback-observed-at "$(now_iso)" \
  --artifact-root "$fixture/out/relayium-ios-0.3.0-1-$short_sha"

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

new_fixture
STUB_SHARE_BUNDLE='com.relayium.app.shareext'
set_default_args
expect_refusal 'a Share extension bundle identifier that drifted is refused' "$REFUSED" 'PRODUCT_BUNDLE_IDENTIFIER' "${DEFAULT_ARGS[@]}"
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
  expect_option 'provisioningProfiles.com\.relayium\.app' 'Relayium iOS App Store'
  expect_option 'provisioningProfiles.com\.relayium\.app\.share' 'Relayium Share Extension App Store'

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
