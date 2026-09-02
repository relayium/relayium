#!/bin/bash
# One signed iOS App Store candidate — archived, exported, verified and
# evidenced — from an exact pushed commit, with NOTHING sent anywhere.
#
# ── what this is for ─────────────────────────────────────────────────────────
#
# `docs/ios-app-store-submission.md` describes a candidate as a signed archive,
# a non-uploading App Store export, a checksum and a symbol/declaration
# readback. Described, that is four operator sessions with four chances to get a
# build number, a profile or a purpose-string check wrong. This script is that
# description made reproducible: one command, one artifact root, one manifest,
# and a precondition ladder that stops BEFORE `xcodebuild archive` whenever any
# part of the contract is unmet.
#
# It is deliberately not a release. It does not upload, does not talk to App
# Store Connect, does not reserve or invent a build number, does not create or
# modify a provisioning profile, and does not delete anything the caller named.
# Producing the artifact and submitting it are separate authorizations, and this
# script only ever performs the first.
#
# ── the App Store Connect read-back is a PRECONDITION, not a formality ───────
#
# App Store Connect owns the build-number sequence, and this repository cannot
# observe it. A build number is consumed the moment a build is accepted — and
# also by builds sitting in `Invalid`, `Processing` or expired-TestFlight
# states — so "build 5 is next" is a local expectation until somebody reads the
# record. Historical `0.1.0` build 3 of this very record was rejected outright,
# which is exactly how a number gets consumed without shipping anything.
#
# So the caller does not tick a box saying they looked. They restate what they
# saw, in three independent pieces that this script cross-checks against each
# other and against the project:
#
#   --marketing-version        the marketing version the candidate submits under
#   --readback-highest-build   the highest build number the record shows
#                              CONSUMED, in any state, for that record
#   --build                    the next free build number
#
# `--build` must be exactly `--readback-highest-build` + 1. Be precise about what
# that buys: it is an EXPLICIT OPERATOR ATTESTATION plus a consistency check, and
# it is not proof that the read-back happened. Nothing here observes App Store
# Connect, so somebody who guesses a highest build and adds one satisfies it just
# as well as somebody who read the record. What it does buy is that the claim is
# stated in a specific, falsifiable form rather than ticked: the operator has to
# name the number they say they saw, it is recorded in the manifest as their
# claim, and a careless off-by-one or a half-remembered number is caught here
# instead of at upload. `--readback-observed-at` then carries the UTC instant the
# operator attests to and must be in the past and no older than
# READBACK_MAX_AGE_SECONDS, because a read-back from last week describes a record
# that has since had time to change.
#
# Both numbers are then required to equal what the PROJECT already declares for
# both targets. This script never edits the project and never lets the export
# renumber the build (`manageAppVersionAndBuildNumber` is false), so a
# disagreement is a refusal rather than something to reconcile silently: bump
# the project in its own reviewed change, then run this.
#
# ── what it refuses, before it builds anything ───────────────────────────────
#
#   * a read-back attestation that is missing, malformed, stale, in the
#     future, or whose two build numbers do not agree;
#   * a selected Xcode that is not exactly major REQUIRED_XCODE_MAJOR, or an
#     iphoneos SDK below MIN_IPHONEOS_SDK_MAJOR — Apple rejects uploads built
#     against anything older, and a candidate that cannot be uploaded is not a
#     candidate;
#   * a dirty worktree, a HEAD that is not a commit, a branch with no upstream,
#     or a HEAD that differs from its upstream. A candidate names a commit
#     somebody else can fetch;
#   * an artifact root that is relative, already exists, sits at depth 1, is a
#     broad or system root, or is inside this repository. The root must NOT
#     already exist, which is the strongest form of "no caller path is touched":
#     there is nothing there to touch. Nothing in this script deletes anything,
#     ever. A refusal raised before the root is created leaves no trace at all;
#     one raised after it (a project setting that disagrees) leaves only this
#     script's own new directory and the build-settings log that explains why;
#   * a project whose team, bundle identifiers, Release signing style or
#     provisioning-profile names differ from the pinned release graph below.
#
# ── what it proves, after it builds ──────────────────────────────────────────
#
# Every check runs against the ARCHIVE and the EXPORTED IPA PAYLOAD, not
# against source, because signing, thinning and packaging all sit between the
# two and each can move what the previous stage established:
#
#   * bundle identifiers, marketing version and build, in the app and in the
#     extension, all equal to what was asked for;
#   * exactly one `.appex` anywhere in the payload, and it is the Share
#     extension;
#   * a distribution signature and this team on both, with `get-task-allow`
#     absent — a development signature would install and would never upload;
#   * the app's three entitlements and the extension's one, INCLUDING the
#     absences: the extension carries no Sign in with Apple and no associated
#     domains, which is a boundary this product argues for in
#     `RelayiumShare.entitlements` and which only a built bundle can confirm;
#   * a valid, non-tracking privacy manifest in both bundles of BOTH the archive
#     and the exported payload, each declaring exactly its own pinned
#     required-reason graph — the app's four categories, the extension's one.
#     Exact in both directions, since a category the source does not justify is
#     as false a public statement as a missing one, and the appex silently
#     shipping the APP's manifest is present, valid and wrong;
#   * both purpose strings in the app, the camera one localized in `en` and
#     `zh-Hans` inside the app bundle where iOS actually reads it, and NO camera
#     declaration and no `.lproj` at all in the extension;
#   * `AVCapture` undefined symbols in the app's OWN binary and in the embedded
#     WebRTC framework. Build 3 of this record was rejected for a missing
#     `NSCameraUsageDescription` against symbols the app did not knowingly use;
#     the app now has a real QR scanner, and this readback is what keeps the
#     declaration and the binary describing the same product.
#
# ── usage ────────────────────────────────────────────────────────────────────
#
#   scripts/ios-app-store-candidate.sh \
#     --marketing-version 0.3.0 \
#     --build 6 \
#     --readback-highest-build 5 \
#     --readback-observed-at 2026-09-02T11:30:00Z \
#     --artifact-root /Users/you/relayium/test-builds/ios/0.3.0-6-<short8-sha>
#
# Exit codes are three classes, so a caller can tell them apart: 2 a refused
# precondition (nothing was built), 3 a failed archive or export (logs kept),
# 4 a candidate that built but failed verification (everything kept).
#
# `scripts/test/ios-app-store-candidate-test.sh` drives this file's refusals and
# its command construction with stubs, and needs no signing identity, device,
# credential or network.

set -euo pipefail

# ── the pinned release graph ─────────────────────────────────────────────────
#
# These are the values `apps/ios/Relayium.xcodeproj` already declares for its
# Release configuration. They are repeated here as an INDEPENDENT statement of
# what a candidate is allowed to be: the script compares the project against
# them and refuses on any difference, so a project edit that changes the team,
# a bundle identifier, the signing style or a profile name cannot silently
# become a candidate.
readonly EXPECTED_TEAM='7PVYUG4YQS'
readonly APP_BUNDLE_ID='com.relayium.app'
readonly SHARE_BUNDLE_ID='com.relayium.app.share'
readonly APP_PROFILE='Relayium iOS App Store'
readonly SHARE_PROFILE='Relayium Share Extension App Store'
readonly APP_TARGET='Relayium'
readonly SHARE_TARGET='RelayiumShare'
readonly APP_BUNDLE_NAME='Relayium.app'
readonly SHARE_BUNDLE_NAME='RelayiumShare.appex'
readonly SCHEME='Relayium'
readonly CONFIGURATION='Release'
readonly ARCHIVE_DESTINATION='generic/platform=iOS'
readonly APP_GROUP='group.com.relayium.app'
readonly ASSOCIATED_DOMAIN='applinks:relayium.com'
readonly APPLE_SIGNIN_VALUE='Default'
readonly WEBRTC_BINARY_RELATIVE='Frameworks/WebRTC.framework/WebRTC'

# ── the required-reason API graph each bundle must declare ───────────────────
#
# Apple's required-reason rule covers iOS, and a manifest is the one file in
# this product that is a PUBLIC STATEMENT rather than an implementation detail:
# it becomes the App Store privacy label, and the app builds, signs and runs
# identically whether it is accurate, wrong or absent. Nothing at runtime
# notices. The first thing that does is an upload rejection or a false label.
#
# So the two graphs are pinned here as sorted `category<TAB>reason,reason`
# lines, and the built bundles are compared against them for EQUALITY.
# `IOSPrivacyManifestTests` derives the same two sets from the source that
# justifies each entry; this is the independent statement of what a BUILT bundle
# is allowed to say, checked where source cannot reach:
#
#   DiskSpace / E174.1       `InboxSpace.freeBytes` calls `statfs` on the
#                            receive folder to refuse a Device Inbox delivery
#                            before writing it. E174.1 covers checking that
#                            there is room to write files, and nothing derived
#                            from the reading leaves the device.
#   FileTimestamp / DDA9.1   `SharedDraftStore.stale` reads `.modificationDate`
#                            inside the App Group container.
#   SystemBootTime / 35F9.1  `WebRTCLinkTransport`'s monotonic deadlines.
#   UserDefaults / CA92.1    `VerificationPreference` and `SharedDraftInbox`.
#
# The Share extension links only `RelayiumShareKit`, so it gets exactly one of
# them. Its manifest being SMALLER is the point: copying the app's four into the
# appex would declare APIs that process cannot call, which is a false statement
# in the direction people assume is safe.
readonly APP_REQUIRED_REASON_GRAPH='NSPrivacyAccessedAPICategoryDiskSpace	E174.1
NSPrivacyAccessedAPICategoryFileTimestamp	DDA9.1
NSPrivacyAccessedAPICategorySystemBootTime	35F9.1
NSPrivacyAccessedAPICategoryUserDefaults	CA92.1'
readonly SHARE_REQUIRED_REASON_GRAPH='NSPrivacyAccessedAPICategoryFileTimestamp	DDA9.1'

# The export contract. `destination = export` is what makes this a build rather
# than a submission: the alternative value is `upload`, and it is the single
# character of configuration between this script and an App Store Connect
# mutation. `manageAppVersionAndBuildNumber = false` keeps Xcode from
# renumbering the build to whatever it thinks is next — the read-back above is
# the only thing allowed to decide that.
readonly EXPORT_DESTINATION='export'
readonly EXPORT_METHOD='app-store-connect'
readonly EXPORT_SIGNING_STYLE='manual'

# Apple has refused App Store Connect uploads built with anything older than
# Xcode 26 and the iOS 26 SDK since 2026-04-28. The Xcode major is REQUIRED
# rather than a floor, for the same reason `.github/workflows/ios.yml` treats it
# that way: a newer major may be a public preview this project holds no
# submission evidence for. The SDK stays a floor, because what Apple validates
# is the SDK the binary was linked against.
readonly REQUIRED_XCODE_MAJOR=26
readonly MIN_IPHONEOS_SDK_MAJOR=26

# Twelve hours. Long enough to read the record, get an approval and build;
# short enough that a read-back from a previous working day cannot authorize a
# build number today. Not overridable: an environment variable that relaxes a
# fail-closed check is the check being absent.
readonly READBACK_MAX_AGE_SECONDS=43200

readonly EXIT_REFUSED=2
readonly EXIT_BUILD_FAILED=3
readonly EXIT_VERIFY_FAILED=4

# ── diagnostics ──────────────────────────────────────────────────────────────

note() { printf '%s\n' "$*"; }
step() { printf '\n== %s\n' "$*"; }

refuse() {
  printf 'REFUSED: %s\n' "$*" >&2
  exit "$EXIT_REFUSED"
}

build_failed() {
  printf 'BUILD FAILED: %s\n' "$*" >&2
  exit "$EXIT_BUILD_FAILED"
}

# Verification findings accumulate rather than exiting at the first one: an
# operator triaging a candidate wants every failed check in one pass, and a
# single early exit would hide the other seven. Nothing is repaired, nothing is
# deleted, and any finding at all is a non-zero exit.
verify_failures=0
fail_check() {
  printf 'VERIFY FAILED: %s\n' "$*" >&2
  verify_failures=$((verify_failures + 1))
}
pass_check() { printf '  ok  %s\n' "$*"; }

usage() {
  cat >&2 <<'USAGE'
usage: scripts/ios-app-store-candidate.sh
         --marketing-version <x.y.z>
         --build <n, decimal, no leading zero>
         --readback-highest-build <n, decimal, no leading zero>
         --readback-observed-at <YYYY-MM-DDTHH:MM:SSZ>
         --artifact-root <absolute path ending in -<short8 sha>, must not exist>

Every option is required. The three App Store Connect values are your
attestation of a fresh read-only inspection of the record: this script cannot
see App Store Connect and cannot confirm that you performed one. --build must be
exactly --readback-highest-build + 1 and both must already equal what the
project declares, which catches an inconsistent or mistyped attestation, not a
fabricated one. This script builds and verifies a candidate. It uploads nothing.
USAGE
  exit "$EXIT_REFUSED"
}

# ── small helpers ────────────────────────────────────────────────────────────

# A plutil key path treats `.` as a SEPARATOR, and this script reads two kinds
# of key that both collide with that: entitlement names, which are full of
# literal dots (`com.apple.developer.applesignin`), and the archive's nested
# `ApplicationProperties` dictionary, where a dot is genuinely a separator.
# Conflating them silently reads the wrong key — an escaped
# `ApplicationProperties\.CFBundleVersion` is a top-level key that does not
# exist, and the check that depended on it would report an absent value rather
# than the version it was asked to confirm.
#
# So a key path is never written inline. Each COMPONENT is passed separately,
# its own dots are escaped, and the separators are the ones this function adds.
plutil_path() {
  local path='' component escaped
  for component in "$@"; do
    escaped="${component//./\\.}"
    if [ -z "$path" ]; then path="$escaped"; else path="$path.$escaped"; fi
  done
  printf '%s' "$path"
}

# Both take an ALREADY-BUILT path from `plutil_path`, so that a caller cannot
# accidentally pass a raw dotted string and get the separator semantics.
plist_value() {
  local file="$1" key_path="$2" format="${3:-raw}"
  plutil -extract "$key_path" "$format" -o - "$file" 2>/dev/null
}

plist_has_key() {
  local file="$1" key_path="$2"
  plutil -extract "$key_path" raw -o - "$file" >/dev/null 2>&1
}

expect_plist_value() {
  local file="$1" key="$2" expected="$3" label="$4" format="${5:-raw}"
  local actual
  if ! actual="$(plist_value "$file" "$key" "$format")"; then
    fail_check "$label: $key is absent from $file"
    return
  fi
  if [ "$actual" != "$expected" ]; then
    fail_check "$label: $key is '$actual', expected '$expected'"
    return
  fi
  pass_check "$label: $key = $expected"
}

expect_plist_key_absent() {
  local file="$1" key="$2" label="$3"
  if plist_has_key "$file" "$key"; then
    fail_check "$label: $key must be absent from $file but is declared"
    return
  fi
  pass_check "$label: $key is absent, as it must be"
}

# ── the required-reason graph of a BUILT manifest ────────────────────────────

# The graph a manifest actually declares, as sorted `category<TAB>reason,reason`
# lines: one line per ENTRY rather than per category, and reasons in file order
# with no deduplication.
#
# Both of those are deliberate, and together they are what makes a plain string
# comparison against the pinned graph fail closed on all four ways this file
# goes wrong:
#
#   * a MISSING category loses a line;
#   * an UNEXPECTED category gains one;
#   * a WRONG reason code changes one;
#   * a DUPLICATED category or reason — which a set-shaped reader would collapse
#     into a graph comparing equal to the correct one — produces a repeated line
#     or a repeated reason instead.
#
# Every value is read through `plutil`, so a manifest that is not a plist, not a
# dictionary, or missing the key entirely fails the extraction rather than
# yielding an empty graph. This function returns NON-ZERO in every one of those
# cases and prints nothing partial: an unreadable manifest must reach the caller
# as a finding, never as a graph that happens to compare unequal for the wrong
# reason.
#
# `plutil -extract <array> raw` prints the element COUNT, which is what the two
# loops below are bounded by. Each count is re-pinned to a canonical nonnegative
# decimal before it reaches arithmetic, so a value that is not a count cannot be
# read as one.
required_reason_graph_of() {
  local file="$1"
  local entry_count entry_index reason_count reason_index
  local category reason reasons lines=''

  entry_count="$(plist_value "$file" "$(plutil_path NSPrivacyAccessedAPITypes)")" || return 1
  [[ "$entry_count" =~ ^(0|[1-9][0-9]*)$ ]] || return 1

  for (( entry_index = 0; entry_index < entry_count; entry_index++ )); do
    category="$(plist_value "$file" \
      "$(plutil_path NSPrivacyAccessedAPITypes "$entry_index" NSPrivacyAccessedAPIType)")" ||
      return 1
    [ -n "$category" ] || return 1

    reason_count="$(plist_value "$file" \
      "$(plutil_path NSPrivacyAccessedAPITypes "$entry_index" NSPrivacyAccessedAPITypeReasons)")" ||
      return 1
    [[ "$reason_count" =~ ^(0|[1-9][0-9]*)$ ]] || return 1

    reasons=''
    for (( reason_index = 0; reason_index < reason_count; reason_index++ )); do
      reason="$(plist_value "$file" \
        "$(plutil_path NSPrivacyAccessedAPITypes "$entry_index" \
                       NSPrivacyAccessedAPITypeReasons "$reason_index")")" || return 1
      [ -n "$reason" ] || return 1
      if [ -z "$reasons" ]; then reasons="$reason"; else reasons="$reasons,$reason"; fi
    done

    lines="$lines$category	$reasons
"
  done

  printf '%s' "$lines" | LC_ALL=C sort
}

# One built bundle's manifest, against the graph it is pinned to. Present, a
# valid plist, non-tracking, and declaring EXACTLY that graph.
#
# Exact rather than "contains", because over-declaring and under-declaring are
# both false public statements and only one of them is the one people worry
# about: a category the source does not justify passes every "is it there" check
# ever written, and reads as caution rather than as the claim it is.
expect_required_reason_graph() {
  local file="$1" expected="$2" label="$3" actual

  if [ ! -f "$file" ]; then
    fail_check "$label: no privacy manifest at $file"
    return
  fi
  if ! plutil -lint "$file" >/dev/null 2>&1; then
    fail_check "$label: the shipped privacy manifest at $file is not a valid plist"
    return
  fi
  pass_check "$label: privacy manifest present and a valid plist"

  expect_plist_value "$file" "$(plutil_path NSPrivacyTracking)" false "$label"

  if ! actual="$(required_reason_graph_of "$file")"; then
    fail_check "$label: $file declares no readable NSPrivacyAccessedAPITypes graph"
    return
  fi
  if [ "$actual" != "$expected" ]; then
    fail_check "$label: the required-reason graph in $file is not the pinned one"
    printf '  expected:\n%s\n  actual:\n%s\n' "$expected" "$actual" >&2
    return
  fi
  pass_check "$label: required-reason graph is exactly the pinned one"
}

# `is_within ANCESTOR CANDIDATE` — true when CANDIDATE is ANCESTOR itself or
# lies beneath it. Both arguments are expected to be physical (symlink-resolved)
# absolute paths; comparing anything else would answer a different question.
is_within() {
  local ancestor="$1" candidate="$2"
  [ "$ancestor" != '/' ] && ancestor="${ancestor%/}"
  [ "$candidate" != '/' ] && candidate="${candidate%/}"
  if [ "$candidate" = "$ancestor" ]; then return 0; fi
  if [ "$ancestor" = '/' ]; then return 0; fi
  case "$candidate" in
    "$ancestor"/*) return 0 ;;
    *) return 1 ;;
  esac
}

# BSD `date` first because this script only runs where `xcodebuild` does; GNU
# `date` second so the contract test can drive this same function on a Linux
# host. The caller has already pinned the shape with a regex, so neither
# implementation is being asked to be strict.
epoch_of_utc_timestamp() {
  local value="$1" epoch
  if epoch="$(date -u -j -f '%Y-%m-%dT%H:%M:%SZ' "$value" '+%s' 2>/dev/null)"; then
    printf '%s\n' "$epoch"
    return 0
  fi
  if epoch="$(date -u -d "$value" '+%s' 2>/dev/null)"; then
    printf '%s\n' "$epoch"
    return 0
  fi
  return 1
}

# The machine-readable manifest is written as a plist and converted with
# `plutil`, so JSON escaping is Apple's problem rather than this script's. What
# remains is XML escaping, and there are exactly three characters to handle.
xml_escape() {
  local value="$1"
  value="${value//&/&amp;}"
  value="${value//</&lt;}"
  value="${value//>/&gt;}"
  printf '%s' "$value"
}

# Counts a newline-separated list without `grep -c`, whose exit status is 1 on
# an empty list and would need a `|| true` this script does not permit itself.
line_count() { printf '%s' "$1" | awk 'NF { n++ } END { print n + 0 }'; }

# Adds one to a canonical nonnegative decimal STRING and prints the canonical
# result, carrying right to left exactly like long addition. Written this way
# because `$(( ))` is fixed-width signed machine arithmetic that wraps silently
# rather than reporting overflow, so a caller-supplied build number long enough
# to exceed 2^64 would compare equal to an unrelated small one. Only one digit
# plus a carry of 0 or 1 ever reaches `$(( ))` here — a value of at most 10,
# which no width or base can misread. Callers must have pinned the input to
# `0|[1-9][0-9]*` first; the result is in that same shape, so the comparison it
# feeds is a plain string comparison.
decimal_increment() {
  local digits="$1" index carry=1 sum result=''
  for (( index = ${#digits} - 1; index >= 0; index-- )); do
    sum=$(( ${digits:index:1} + carry ))
    if [ "$sum" -eq 10 ]; then
      sum=0
      carry=1
    else
      carry=0
    fi
    result="$sum$result"
  done
  [ "$carry" -eq 0 ] || result="1$result"
  printf '%s' "$result"
}

# ── 1. arguments ─────────────────────────────────────────────────────────────

marketing_version=''
build_number=''
readback_highest_build=''
readback_observed_at=''
artifact_root=''

while [ "$#" -gt 0 ]; do
  case "$1" in
    --marketing-version) [ "$#" -ge 2 ] || usage; marketing_version="$2"; shift 2 ;;
    --build) [ "$#" -ge 2 ] || usage; build_number="$2"; shift 2 ;;
    --readback-highest-build) [ "$#" -ge 2 ] || usage; readback_highest_build="$2"; shift 2 ;;
    --readback-observed-at) [ "$#" -ge 2 ] || usage; readback_observed_at="$2"; shift 2 ;;
    --artifact-root) [ "$#" -ge 2 ] || usage; artifact_root="$2"; shift 2 ;;
    -h|--help) usage ;;
    *) printf 'unknown argument: %s\n' "$1" >&2; usage ;;
  esac
done

[ -n "$marketing_version" ] || { printf 'missing --marketing-version\n' >&2; usage; }
[ -n "$build_number" ] || { printf 'missing --build\n' >&2; usage; }
[ -n "$readback_highest_build" ] || { printf 'missing --readback-highest-build\n' >&2; usage; }
[ -n "$readback_observed_at" ] || { printf 'missing --readback-observed-at\n' >&2; usage; }
[ -n "$artifact_root" ] || { printf 'missing --artifact-root\n' >&2; usage; }

# ── 2. the App Store Connect read-back attestation ───────────────────────────

step 'App Store Connect read-back attestation'

[[ "$marketing_version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] ||
  refuse "--marketing-version '$marketing_version' is not an x.y.z marketing version"

# CANONICAL decimal, not merely "digits". `^[0-9]+$` accepts `08`, and a leading
# zero is an operator error worth naming rather than tolerating: `010` from
# somebody who means ten is not the number they mean, this string is recorded in
# the manifest as their claim, and two spellings of one value would make the
# string comparison below disagree for a reason the message could not explain.
#
# The guard's origin is sharper still and is worth keeping on the record,
# because it is what a later loosening would reintroduce. That comparison used
# to be `$(( ))` arithmetic, where a leading zero means OCTAL:
# `--readback-highest-build 010` evaluated to 8 and ACCEPTED `--build 9` as the
# next free build — a wrong number, accepted quietly, which is the one outcome
# this section exists to prevent. `08` and `09` are not valid octal at all and
# killed the script with exit 1, which belongs to none of the three documented
# outcome classes. The arithmetic is gone now; the shape check stays, because a
# rule that holds only while an implementation detail holds is not a rule.
#
# So the shape is pinned to what App Store Connect actually shows: a build is at
# least 1, and a highest-consumed build may be 0 because a record with nothing
# consumed yet is the honest first case.
[[ "$build_number" =~ ^[1-9][0-9]*$ ]] ||
  refuse "--build '$build_number' is not a canonical positive decimal build number; write it as [1-9][0-9]* — no leading zero, sign, space or other text"
[[ "$readback_highest_build" =~ ^(0|[1-9][0-9]*)$ ]] ||
  refuse "--readback-highest-build '$readback_highest_build' is not a canonical nonnegative decimal build number; write it as 0 or [1-9][0-9]* — no leading zero, sign, space or other text"

# The consistency check, and only that. Two numbers that must agree is an
# operator attestation stated in a falsifiable form: it catches an off-by-one, a
# transposition or a number carried over from the last candidate. It does not
# prove the read-back happened — nothing local can — because a caller who guesses
# a highest build and adds one satisfies it identically.
#
# The comparison is on DECIMAL STRINGS, computed one digit at a time, and never
# on whole-number `$(( ))`. Bash arithmetic is fixed-width signed machine
# integers, and it does not report overflow: `10#` fixes the base but not the
# width, so `$((10#18446744073709551617))` is `1` — the value wraps modulo 2^64
# and comes out equal to the next free build after a highest of `0`. That input
# is canonical decimal, so no regex above rejects it, and the cross-check would
# have passed a build number App Store Connect could never accept. Refusing
# "too long" instead would only move the problem to an undocumented maximum
# somebody has to keep in step with Apple's, so the arithmetic is removed
# rather than bounded: `decimal_increment` carries across digits like long
# addition and is exact at any length, and `[ x != y ]` compares the canonical
# spellings the regexes already pinned.
next_free_build="$(decimal_increment "$readback_highest_build")"
if [ "$build_number" != "$next_free_build" ]; then
  refuse "--build $build_number is not the next free build after the attested highest consumed build $readback_highest_build; the next free build is $next_free_build"
fi

[[ "$readback_observed_at" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$ ]] ||
  refuse "--readback-observed-at '$readback_observed_at' is not a UTC timestamp of the form YYYY-MM-DDTHH:MM:SSZ"

readback_epoch=''
readback_epoch="$(epoch_of_utc_timestamp "$readback_observed_at")" ||
  refuse "--readback-observed-at '$readback_observed_at' is not a real instant"
now_epoch="$(date -u '+%s')"

if [ "$readback_epoch" -gt "$now_epoch" ]; then
  refuse "--readback-observed-at $readback_observed_at is in the future; a read-back that has not happened yet cannot authorize a build number"
fi

readback_age=$((now_epoch - readback_epoch))
if [ "$readback_age" -gt "$READBACK_MAX_AGE_SECONDS" ]; then
  refuse "the App Store Connect read-back is ${readback_age}s old, older than the ${READBACK_MAX_AGE_SECONDS}s this script accepts; re-inspect the record and supply the current numbers"
fi

note "attested read-back at $readback_observed_at (${readback_age}s ago)"
note "highest consumed build attested: $readback_highest_build"
note "candidate: $marketing_version ($build_number)"

# ── 3. toolchain ─────────────────────────────────────────────────────────────

step 'toolchain'

command -v xcodebuild >/dev/null 2>&1 || refuse 'xcodebuild is not on PATH'
command -v xcrun >/dev/null 2>&1 || refuse 'xcrun is not on PATH'

xcodebuild_version_report=''
xcodebuild_version_report="$(xcodebuild -version 2>/dev/null)" ||
  refuse 'xcodebuild -version failed; no usable Xcode is selected'

xcode_version="$(printf '%s\n' "$xcodebuild_version_report" | awk '/^Xcode / { print $2; exit }')"
xcode_build="$(printf '%s\n' "$xcodebuild_version_report" | awk '/^Build version / { print $3; exit }')"
[ -n "$xcode_version" ] && [ -n "$xcode_build" ] ||
  refuse 'xcodebuild -version did not report both a version and a build'

xcode_major="${xcode_version%%.*}"
[[ "$xcode_major" =~ ^[0-9]+$ ]] || refuse "cannot read a major version out of Xcode '$xcode_version'"
if [ "$xcode_major" -ne "$REQUIRED_XCODE_MAJOR" ]; then
  refuse "selected Xcode is $xcode_version, not the required major $REQUIRED_XCODE_MAJOR; Apple does not accept an App Store upload built with another major"
fi

iphoneos_sdk_version=''
iphoneos_sdk_version="$(xcrun --sdk iphoneos --show-sdk-version 2>/dev/null)" ||
  refuse 'no iphoneos SDK is available in the selected Xcode'
iphoneos_sdk_major="${iphoneos_sdk_version%%.*}"
[[ "$iphoneos_sdk_major" =~ ^[0-9]+$ ]] ||
  refuse "cannot read a major version out of iphoneos SDK '$iphoneos_sdk_version'"
if [ "$iphoneos_sdk_major" -lt "$MIN_IPHONEOS_SDK_MAJOR" ]; then
  refuse "iphoneos SDK $iphoneos_sdk_version is below the App Store minimum major $MIN_IPHONEOS_SDK_MAJOR; an archive linked against it is rejected at upload"
fi

note "Xcode $xcode_version ($xcode_build)"
note "iphoneos SDK $iphoneos_sdk_version"

# ── 4. repository state ──────────────────────────────────────────────────────

step 'repository state'

script_dir="$(unset CDPATH; cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
repo_root=''
repo_root="$(git -C "$script_dir" rev-parse --show-toplevel 2>/dev/null)" ||
  refuse "$script_dir is not inside a Git repository"
repo_root="$(unset CDPATH; cd -- "$repo_root" && pwd -P)"

git -C "$repo_root" rev-parse --verify --quiet 'HEAD^{commit}' >/dev/null ||
  refuse 'HEAD is not a commit; a candidate must name a commit that exists'

worktree_state="$(git -C "$repo_root" status --porcelain)"
if [ -n "$worktree_state" ]; then
  printf '%s\n' "$worktree_state" >&2
  refuse 'the worktree is not clean; a candidate must be reproducible from a committed tree'
fi

upstream_ref=''
upstream_ref="$(git -C "$repo_root" rev-parse --abbrev-ref --symbolic-full-name '@{upstream}' 2>/dev/null)" ||
  refuse 'the current branch has no upstream; a candidate must name a commit somebody else can fetch'

head_sha="$(git -C "$repo_root" rev-parse HEAD)"
upstream_sha="$(git -C "$repo_root" rev-parse '@{upstream}')"
if [ "$head_sha" != "$upstream_sha" ]; then
  refuse "HEAD $head_sha differs from upstream $upstream_ref $upstream_sha; push the exact candidate commit first"
fi

short_sha="$(git -C "$repo_root" rev-parse --short=8 HEAD)"
branch_name="$(git -C "$repo_root" rev-parse --abbrev-ref HEAD)"
note "commit $head_sha on $branch_name, matching $upstream_ref"

project_path="$repo_root/apps/ios/Relayium.xcodeproj"
[ -d "$project_path" ] || refuse "the iOS project is missing at $project_path"

# ── 5. artifact root ─────────────────────────────────────────────────────────
#
# Every check below happens before a single byte is written, and the root must
# not already exist — so no caller path is read, moved, emptied or removed by
# any outcome of this script. A refusal from this section creates nothing; a
# refusal from a later one has only this script's own fresh directory to leave
# behind.

step 'artifact root'

case "$artifact_root" in
  /*) ;;
  *) refuse "--artifact-root '$artifact_root' must be absolute" ;;
esac

artifact_parent="$(dirname -- "$artifact_root")"
artifact_name="$(basename -- "$artifact_root")"

[ -n "$artifact_name" ] && [ "$artifact_name" != '.' ] && [ "$artifact_name" != '..' ] &&
  [ "$artifact_name" != '/' ] ||
  refuse "--artifact-root '$artifact_root' does not name a new directory"

case "$artifact_name" in
  *-"$short_sha") ;;
  *) refuse "the artifact directory name must end with the candidate commit '-$short_sha'; '$artifact_name' does not" ;;
esac

[ -d "$artifact_parent" ] ||
  refuse "the parent of --artifact-root does not exist: $artifact_parent"

artifact_parent="$(unset CDPATH; cd -- "$artifact_parent" && pwd -P)"
artifact_resolved="${artifact_parent%/}/$artifact_name"

if [ -e "$artifact_resolved" ] || [ -L "$artifact_resolved" ]; then
  refuse "--artifact-root already exists: $artifact_resolved. Name a new directory; this script never writes into, empties or removes an existing one"
fi

# Depth. `/candidate-abcd1234` is absolute, does not exist, and would still put
# a multi-gigabyte build tree at the root of the volume.
artifact_depth="$(printf '%s' "${artifact_resolved#/}" | awk -F/ '{ print NF }')"
if [ "$artifact_depth" -lt 2 ]; then
  refuse "--artifact-root $artifact_resolved sits directly under /; name a directory at least two levels deep"
fi

# Broad and system roots, checked by EQUALITY of the resolved parent rather than
# containment: `/private/var/folders/...` is where macOS puts a temporary
# directory, and refusing everything under `/private` would refuse the ordinary
# case along with the dangerous one. What must never happen is a build tree
# written directly into one of these.
#
# The comparison is against the RESOLVED parent, so the list carries both the
# names an operator types and the ones macOS resolves them to — `/tmp` is a
# symlink to `/private/tmp`, and a list that named only the first would never
# match.
for unsafe_parent in / /Users /Applications /Library /System /Volumes /Network \
    /usr /bin /sbin /etc /opt /var /private /tmp /cores /dev \
    /private/etc /private/tmp /private/var "${HOME:-/nonexistent}"; do
  if [ "$artifact_parent" = "$unsafe_parent" ]; then
    refuse "--artifact-root would write directly into $unsafe_parent; choose a dedicated artifact directory"
  fi
done

if is_within "$repo_root" "$artifact_resolved"; then
  refuse "--artifact-root $artifact_resolved is inside the repository at $repo_root; candidate artifacts are kept outside the source tree"
fi
# The converse — an artifact root that CONTAINS the repository — needs no check
# of its own. The repository exists, so every ancestor of it exists, and a path
# that already exists was refused above. A guard here would be unreachable, and
# an unreachable guard is the kind of thing a later reader deletes for the wrong
# reason.

mkdir "$artifact_resolved"
artifact_root="$artifact_resolved"
logs_dir="$artifact_root/logs"
mkdir "$logs_dir"
note "artifact root $artifact_root"

# ── 6. the project must already declare this candidate ───────────────────────

step 'project settings'

settings_of_target() {
  local target="$1"
  local out="$logs_dir/build-settings-$target.txt"
  if ! xcodebuild \
      -project "$project_path" \
      -target "$target" \
      -configuration "$CONFIGURATION" \
      -destination "$ARCHIVE_DESTINATION" \
      -showBuildSettings >"$out" 2>&1; then
    cat "$out" >&2
    refuse "xcodebuild -showBuildSettings failed for target $target; log kept at $out"
  fi
  printf '%s\n' "$out"
}

setting_value() {
  local file="$1" key="$2"
  awk -v key="$key" '
    { line = $0; sub(/^[[:space:]]+/, "", line) }
    index(line, key " = ") == 1 { print substr(line, length(key) + 4); found = 1; exit }
    END { if (!found) exit 1 }
  ' "$file"
}

expect_setting() {
  local file="$1" target="$2" key="$3" expected="$4" actual
  if ! actual="$(setting_value "$file" "$key")"; then
    refuse "target $target declares no $key; the pinned release graph requires $key = $expected"
  fi
  if [ "$actual" != "$expected" ]; then
    refuse "target $target has $key = '$actual', but this candidate requires '$expected'"
  fi
  note "  $target $key = $expected"
}

app_settings="$(settings_of_target "$APP_TARGET")"
share_settings="$(settings_of_target "$SHARE_TARGET")"

expect_setting "$app_settings" "$APP_TARGET" MARKETING_VERSION "$marketing_version"
expect_setting "$app_settings" "$APP_TARGET" CURRENT_PROJECT_VERSION "$build_number"
expect_setting "$app_settings" "$APP_TARGET" PRODUCT_BUNDLE_IDENTIFIER "$APP_BUNDLE_ID"
expect_setting "$app_settings" "$APP_TARGET" DEVELOPMENT_TEAM "$EXPECTED_TEAM"
expect_setting "$app_settings" "$APP_TARGET" CODE_SIGN_STYLE Manual
expect_setting "$app_settings" "$APP_TARGET" PROVISIONING_PROFILE_SPECIFIER "$APP_PROFILE"

expect_setting "$share_settings" "$SHARE_TARGET" MARKETING_VERSION "$marketing_version"
expect_setting "$share_settings" "$SHARE_TARGET" CURRENT_PROJECT_VERSION "$build_number"
expect_setting "$share_settings" "$SHARE_TARGET" PRODUCT_BUNDLE_IDENTIFIER "$SHARE_BUNDLE_ID"
expect_setting "$share_settings" "$SHARE_TARGET" DEVELOPMENT_TEAM "$EXPECTED_TEAM"
expect_setting "$share_settings" "$SHARE_TARGET" CODE_SIGN_STYLE Manual
expect_setting "$share_settings" "$SHARE_TARGET" PROVISIONING_PROFILE_SPECIFIER "$SHARE_PROFILE"

# ── 7. export options ────────────────────────────────────────────────────────
#
# Generated here, inside the artifact root, rather than committed: a checked-in
# ExportOptions.plist is a file somebody edits once and nobody reads again, and
# the manifest below records the exact bytes this run used.

step 'export options'

export_options="$artifact_root/ExportOptions.plist"
cat >"$export_options" <<EXPORT_OPTIONS
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>destination</key>
	<string>$EXPORT_DESTINATION</string>
	<key>method</key>
	<string>$EXPORT_METHOD</string>
	<key>teamID</key>
	<string>$EXPECTED_TEAM</string>
	<key>signingStyle</key>
	<string>$EXPORT_SIGNING_STYLE</string>
	<key>manageAppVersionAndBuildNumber</key>
	<false/>
	<key>provisioningProfiles</key>
	<dict>
		<key>$APP_BUNDLE_ID</key>
		<string>$APP_PROFILE</string>
		<key>$SHARE_BUNDLE_ID</key>
		<string>$SHARE_PROFILE</string>
	</dict>
</dict>
</plist>
EXPORT_OPTIONS

plutil -lint "$export_options" >/dev/null ||
  refuse "the generated export options are not a valid plist: $export_options"
note "wrote $export_options"

# ── 8. archive ───────────────────────────────────────────────────────────────
#
# `-allowProvisioningUpdates` is deliberately absent and must stay absent. It
# authorizes Xcode to register devices and to create or modify provisioning
# profiles in the developer account — a provider mutation, performed by a script
# whose whole contract is that it performs none. Manual signing against the two
# pinned profiles is the point: if a profile is missing or expired, the correct
# outcome is a failed archive an operator investigates, not a profile this
# script quietly minted.

step 'archive'

archive_path="$artifact_root/$SCHEME.xcarchive"
derived_data="$artifact_root/DerivedData"
archive_log="$logs_dir/archive.log"

note "archiving $SCHEME ($CONFIGURATION) for $ARCHIVE_DESTINATION"
if ! xcodebuild \
    -project "$project_path" \
    -scheme "$SCHEME" \
    -configuration "$CONFIGURATION" \
    -destination "$ARCHIVE_DESTINATION" \
    -archivePath "$archive_path" \
    -derivedDataPath "$derived_data" \
    archive 2>&1 | tee "$archive_log"; then
  build_failed "xcodebuild archive failed; the complete log is preserved at $archive_log"
fi

[ -d "$archive_path" ] ||
  build_failed "xcodebuild archive reported success but produced no archive at $archive_path; log at $archive_log"

# ── 9. export ────────────────────────────────────────────────────────────────

step 'export'

export_dir="$artifact_root/export"
export_log="$logs_dir/export.log"

if ! xcodebuild \
    -exportArchive \
    -archivePath "$archive_path" \
    -exportOptionsPlist "$export_options" \
    -exportPath "$export_dir" 2>&1 | tee "$export_log"; then
  build_failed "xcodebuild -exportArchive failed; the complete log is preserved at $export_log"
fi

ipa_path="$export_dir/$SCHEME.ipa"
[ -f "$ipa_path" ] ||
  build_failed "the export produced no IPA at $ipa_path; log at $export_log"

# ── 10. verification ─────────────────────────────────────────────────────────

step 'verification'

archive_info="$archive_path/Info.plist"
[ -f "$archive_info" ] || fail_check "the archive has no Info.plist at $archive_info"

if [ -f "$archive_info" ]; then
  expect_plist_value "$archive_info" "$(plutil_path ApplicationProperties CFBundleIdentifier)" "$APP_BUNDLE_ID" 'archive'
  expect_plist_value "$archive_info" "$(plutil_path ApplicationProperties CFBundleShortVersionString)" "$marketing_version" 'archive'
  expect_plist_value "$archive_info" "$(plutil_path ApplicationProperties CFBundleVersion)" "$build_number" 'archive'
  if archive_identity="$(plist_value "$archive_info" "$(plutil_path ApplicationProperties SigningIdentity)")"; then
    case "$archive_identity" in
      'Apple Distribution'*|'iPhone Distribution'*)
        pass_check "archive: signed by '$archive_identity'" ;;
      *)
        fail_check "archive: signing identity '$archive_identity' is not a distribution identity" ;;
    esac
  else
    fail_check 'archive: no SigningIdentity recorded; the archive is unsigned'
  fi
fi

# The exported payload, unpacked into a directory that did not exist. `unzip`
# is given a fresh destination and nothing is removed afterwards: the unpacked
# tree is part of the evidence.
verify_dir="$artifact_root/verify"
mkdir "$verify_dir"
payload_dir="$verify_dir/ipa"
if ! unzip -q "$ipa_path" -d "$payload_dir"; then
  build_failed "could not unpack the exported IPA at $ipa_path"
fi

app_dir="$payload_dir/Payload/$APP_BUNDLE_NAME"
[ -d "$app_dir" ] || build_failed "the IPA payload has no $APP_BUNDLE_NAME at $app_dir"

# Exactly one extension, anywhere in the payload. A second copy of the same
# `.appex` nested inside a framework is the classic "Invalid Bundle Structure"
# rejection, and it is invisible from source.
appex_list="$(find "$app_dir" -name '*.appex' -print | sort)"
appex_count="$(line_count "$appex_list")"
if [ "$appex_count" -ne 1 ]; then
  fail_check "the payload embeds $appex_count .appex bundles, expected exactly 1:"
  printf '%s\n' "$appex_list" >&2
else
  pass_check "the payload embeds exactly one .appex"
fi

appex_dir="$app_dir/PlugIns/$SHARE_BUNDLE_NAME"
if [ ! -d "$appex_dir" ]; then
  fail_check "the Share extension is not at $appex_dir"
fi

app_info="$app_dir/Info.plist"
appex_info="$appex_dir/Info.plist"

if [ -f "$app_info" ]; then
  expect_plist_value "$app_info" "$(plutil_path CFBundleIdentifier)" "$APP_BUNDLE_ID" 'app'
  expect_plist_value "$app_info" "$(plutil_path CFBundleShortVersionString)" "$marketing_version" 'app'
  expect_plist_value "$app_info" "$(plutil_path CFBundleVersion)" "$build_number" 'app'
else
  fail_check "the app bundle has no Info.plist at $app_info"
fi

if [ -f "$appex_info" ]; then
  expect_plist_value "$appex_info" "$(plutil_path CFBundleIdentifier)" "$SHARE_BUNDLE_ID" 'share'
  expect_plist_value "$appex_info" "$(plutil_path CFBundleShortVersionString)" "$marketing_version" 'share'
  expect_plist_value "$appex_info" "$(plutil_path CFBundleVersion)" "$build_number" 'share'
else
  fail_check "the Share extension has no Info.plist at $appex_info"
fi

# Signatures. `--verify --strict` on each bundle separately rather than
# `--deep`, which Apple documents as unsuitable for verification of a nested
# bundle's own signing requirements.
verify_signature() {
  local bundle="$1" label="$2"
  [ -d "$bundle" ] || return 0
  if ! codesign --verify --strict "$bundle" >>"$logs_dir/codesign.log" 2>&1; then
    fail_check "$label: codesign --verify --strict failed; see $logs_dir/codesign.log"
    return 0
  fi
  pass_check "$label: signature verifies"

  local report team authority
  if ! report="$(codesign -dvv "$bundle" 2>&1)"; then
    fail_check "$label: could not read the signature"
    return 0
  fi
  printf '%s\n' "$report" >>"$logs_dir/codesign.log"

  team="$(printf '%s\n' "$report" | awk -F= '/^TeamIdentifier=/ { print $2; exit }')"
  if [ "$team" != "$EXPECTED_TEAM" ]; then
    fail_check "$label: TeamIdentifier is '$team', expected '$EXPECTED_TEAM'"
  else
    pass_check "$label: TeamIdentifier $EXPECTED_TEAM"
  fi

  authority="$(printf '%s\n' "$report" | awk -F= '/^Authority=/ { print $2; exit }')"
  case "$authority" in
    'Apple Distribution'*|'iPhone Distribution'*)
      pass_check "$label: distribution authority '$authority'" ;;
    *)
      fail_check "$label: signing authority '$authority' is not a distribution authority; a development signature never uploads" ;;
  esac
}

verify_signature "$app_dir" 'app'
verify_signature "$appex_dir" 'share'

# Entitlements, read out of the signed bundle rather than the source file,
# because what a bundle claims after signing is the only version that matters.
entitlements_of() {
  local bundle="$1" out="$2"
  codesign -d --entitlements - --xml "$bundle" >"$out" 2>>"$logs_dir/codesign.log" || return 1
  plutil -lint "$out" >/dev/null 2>&1 || return 1
  return 0
}

app_entitlements="$verify_dir/app-entitlements.plist"
if [ -d "$app_dir" ] && entitlements_of "$app_dir" "$app_entitlements"; then
  expect_plist_value "$app_entitlements" "$(plutil_path 'application-identifier')" "$EXPECTED_TEAM.$APP_BUNDLE_ID" 'app entitlements'
  expect_plist_value "$app_entitlements" "$(plutil_path 'com.apple.developer.team-identifier')" "$EXPECTED_TEAM" 'app entitlements'
  expect_plist_value "$app_entitlements" "$(plutil_path 'com.apple.developer.applesignin')" "[\"$APPLE_SIGNIN_VALUE\"]" 'app entitlements' json
  expect_plist_value "$app_entitlements" "$(plutil_path 'com.apple.developer.associated-domains')" "[\"$ASSOCIATED_DOMAIN\"]" 'app entitlements' json
  expect_plist_value "$app_entitlements" "$(plutil_path 'com.apple.security.application-groups')" "[\"$APP_GROUP\"]" 'app entitlements' json
  # A distribution build must not be debuggable, and must not claim push it
  # neither registers for nor implements.
  expect_plist_key_absent "$app_entitlements" "$(plutil_path 'get-task-allow')" 'app entitlements'
  expect_plist_key_absent "$app_entitlements" "$(plutil_path 'aps-environment')" 'app entitlements'
else
  fail_check "could not read the app's entitlements out of $app_dir"
fi

share_entitlements="$verify_dir/share-entitlements.plist"
if [ -d "$appex_dir" ] && entitlements_of "$appex_dir" "$share_entitlements"; then
  expect_plist_value "$share_entitlements" "$(plutil_path 'application-identifier')" "$EXPECTED_TEAM.$SHARE_BUNDLE_ID" 'share entitlements'
  expect_plist_value "$share_entitlements" "$(plutil_path 'com.apple.security.application-groups')" "[\"$APP_GROUP\"]" 'share entitlements' json
  # The extension boundary, stated as absences because that is what it is: the
  # extension stages files into the App Group and holds no account, no
  # credential and no link surface.
  expect_plist_key_absent "$share_entitlements" "$(plutil_path 'com.apple.developer.applesignin')" 'share entitlements'
  expect_plist_key_absent "$share_entitlements" "$(plutil_path 'com.apple.developer.associated-domains')" 'share entitlements'
  expect_plist_key_absent "$share_entitlements" "$(plutil_path 'keychain-access-groups')" 'share entitlements'
  expect_plist_key_absent "$share_entitlements" "$(plutil_path 'get-task-allow')" 'share entitlements'
else
  fail_check "could not read the Share extension's entitlements out of $appex_dir"
fi

# Privacy manifests — present, valid, non-tracking, and declaring EXACTLY the
# required-reason graph the source justifies.
#
# Read in FOUR places, because they are four different files and each stage
# between them can move what the previous one established:
#
#   * the archive is what Xcode produced;
#   * the export re-signs and repackages it, so a resource that survived the
#     archive is not evidence it survived the export;
#   * and within each of those, the app's manifest and the extension's are
#     deliberately different sizes. The appex is a separate bundle Apple reads a
#     separate file for, and the classic failure is not a missing manifest but
#     the APP's manifest ending up in the extension — valid, present, lint-clean,
#     and declaring three APIs that process cannot call.
#
# Comparing each against its own pinned graph is what tells those two files
# apart. A presence check cannot.
archive_app_dir="$archive_path/Products/Applications/$APP_BUNDLE_NAME"
archive_appex_dir="$archive_app_dir/PlugIns/$SHARE_BUNDLE_NAME"

expect_required_reason_graph "$archive_app_dir/PrivacyInfo.xcprivacy" \
  "$APP_REQUIRED_REASON_GRAPH" 'archive app privacy manifest'
expect_required_reason_graph "$archive_appex_dir/PrivacyInfo.xcprivacy" \
  "$SHARE_REQUIRED_REASON_GRAPH" 'archive share privacy manifest'
expect_required_reason_graph "$app_dir/PrivacyInfo.xcprivacy" \
  "$APP_REQUIRED_REASON_GRAPH" 'app privacy manifest'
expect_required_reason_graph "$appex_dir/PrivacyInfo.xcprivacy" \
  "$SHARE_REQUIRED_REASON_GRAPH" 'share privacy manifest'

# Protected-resource declarations. The app declares both purpose strings and
# localizes the camera one where iOS reads it — the app's OWN bundle, before any
# Relayium code runs. The extension declares neither and carries no .lproj at
# all; iOS attributes an extension's prompt to its host app, so a camera string
# there would be a claim about a process that opens no camera.
if [ -f "$app_info" ]; then
  for purpose_key in NSCameraUsageDescription NSLocalNetworkUsageDescription; do
    if purpose_text="$(plist_value "$app_info" "$(plutil_path "$purpose_key")")" && [ -n "$purpose_text" ]; then
      pass_check "app: $purpose_key declared"
    else
      fail_check "app: $purpose_key is missing or empty in the built Info.plist"
    fi
  done
fi

for language in en zh-Hans; do
  strings_file="$app_dir/$language.lproj/InfoPlist.strings"
  if [ ! -f "$strings_file" ]; then
    fail_check "app: no $language InfoPlist.strings in the built bundle"
    continue
  fi
  if localized_camera="$(plist_value "$strings_file" "$(plutil_path NSCameraUsageDescription)")" && [ -n "$localized_camera" ]; then
    pass_check "app: $language camera purpose string is localized in the bundle"
  else
    fail_check "app: $language InfoPlist.strings carries no NSCameraUsageDescription"
  fi
done

if [ -f "$appex_info" ]; then
  expect_plist_key_absent "$appex_info" "$(plutil_path NSCameraUsageDescription)" 'share'
fi
if [ -d "$appex_dir" ]; then
  share_lproj="$(find "$appex_dir" -name '*.lproj' -type d -print | sort)"
  if [ -n "$share_lproj" ]; then
    fail_check "share: the extension carries .lproj directories it should not:"
    printf '%s\n' "$share_lproj" >&2
  else
    pass_check 'share: no .lproj directories, and so no localized purpose string'
  fi
fi

# The AVCapture readback. Build 3 of this record was rejected for a missing
# camera purpose string against symbols the product did not knowingly use. The
# app now has a real scanner, so the expectation has flipped: the app's OWN
# binary must reference capture APIs, and so must the embedded WebRTC framework.
# `awk` rather than `grep` so an empty result is a value this script decides
# about, not an exit status that quietly ends a pipeline.
avcapture_symbols_of() {
  local binary="$1"
  xcrun nm -u "$binary" | awk '/AVCapture/ { print }' | sort
}

app_binary="$app_dir/$SCHEME"
app_avcapture=''
app_avcapture_count=0
if [ -f "$app_binary" ]; then
  app_avcapture="$(avcapture_symbols_of "$app_binary")"
  app_avcapture_count="$(line_count "$app_avcapture")"
  if [ "$app_avcapture_count" -lt 1 ]; then
    fail_check "app: the binary references no AVCapture symbol, but the app declares NSCameraUsageDescription and ships a QR scanner"
  else
    pass_check "app: $app_avcapture_count undefined AVCapture symbols"
    printf '%s\n' "$app_avcapture" >"$verify_dir/avcapture-app.txt"
  fi
else
  fail_check "app: no executable at $app_binary"
fi

webrtc_binary="$app_dir/$WEBRTC_BINARY_RELATIVE"
webrtc_avcapture=''
webrtc_avcapture_count=0
if [ -f "$webrtc_binary" ]; then
  webrtc_avcapture="$(avcapture_symbols_of "$webrtc_binary")"
  webrtc_avcapture_count="$(line_count "$webrtc_avcapture")"
  if [ "$webrtc_avcapture_count" -lt 1 ]; then
    fail_check 'webrtc: the embedded framework references no AVCapture symbol; this contradicts every previous readback and must be understood before upload'
  else
    pass_check "webrtc: $webrtc_avcapture_count undefined AVCapture symbols"
    printf '%s\n' "$webrtc_avcapture" >"$verify_dir/avcapture-webrtc.txt"
  fi
else
  fail_check "webrtc: no embedded framework binary at $webrtc_binary"
fi

# ── 11. evidence ─────────────────────────────────────────────────────────────

step 'evidence'

ipa_sha256="$(shasum -a 256 "$ipa_path" | awk '{ print $1 }')"
archive_app_binary="$archive_app_dir/$SCHEME"
archive_binary_sha256='unavailable'
if [ -f "$archive_app_binary" ]; then
  archive_binary_sha256="$(shasum -a 256 "$archive_app_binary" | awk '{ print $1 }')"
fi
export_options_sha256="$(shasum -a 256 "$export_options" | awk '{ print $1 }')"

manifest_txt="$artifact_root/candidate-manifest.txt"
cat >"$manifest_txt" <<MANIFEST
Relayium iOS App Store candidate
================================

This artifact was produced by scripts/ios-app-store-candidate.sh. It has NOT
been uploaded, and building it reserved no App Store Connect build number.

Source
  commit                  $head_sha
  short commit            $short_sha
  branch                  $branch_name
  upstream                $upstream_ref ($upstream_sha)

Identity
  marketing version       $marketing_version
  build                   $build_number

App Store Connect read-back (attested by the operator; NOT observed or
verified here, and not proof the inspection happened)
  attested observation    $readback_observed_at
  age at build            ${readback_age}s
  highest consumed build  $readback_highest_build

Toolchain
  Xcode                   $xcode_version ($xcode_build)
  iphoneos SDK            $iphoneos_sdk_version

Release graph
  team                    $EXPECTED_TEAM
  app bundle              $APP_BUNDLE_ID  ($APP_PROFILE)
  share bundle            $SHARE_BUNDLE_ID  ($SHARE_PROFILE)
  export destination      $EXPORT_DESTINATION
  export method           $EXPORT_METHOD
  signing style           $EXPORT_SIGNING_STYLE
  build number managed    no

Artifacts
  archive                 $archive_path
  archived app binary     sha256 $archive_binary_sha256
  ipa                     $ipa_path
  ipa                     sha256 $ipa_sha256
  export options          $export_options
  export options          sha256 $export_options_sha256
  archive log             $archive_log
  export log              $export_log

Verification findings          $verify_failures
MANIFEST

# The machine-readable half is authored as a plist and converted by `plutil`,
# which means the JSON is valid by construction rather than by careful quoting,
# and the plist is linted before anything reads it.
manifest_plist="$artifact_root/candidate-manifest.plist"
manifest_json="$artifact_root/candidate-manifest.json"

cat >"$manifest_plist" <<MANIFEST_PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>schema</key>
	<string>relayium.ios.candidate.v1</string>
	<key>uploaded</key>
	<false/>
	<key>commit</key>
	<string>$(xml_escape "$head_sha")</string>
	<key>shortCommit</key>
	<string>$(xml_escape "$short_sha")</string>
	<key>branch</key>
	<string>$(xml_escape "$branch_name")</string>
	<key>upstream</key>
	<string>$(xml_escape "$upstream_ref")</string>
	<key>upstreamCommit</key>
	<string>$(xml_escape "$upstream_sha")</string>
	<key>marketingVersion</key>
	<string>$(xml_escape "$marketing_version")</string>
	<key>build</key>
	<string>$(xml_escape "$build_number")</string>
	<key>appStoreConnectReadback</key>
	<dict>
		<key>observedAt</key>
		<string>$(xml_escape "$readback_observed_at")</string>
		<key>ageSecondsAtBuild</key>
		<integer>$readback_age</integer>
		<key>highestConsumedBuild</key>
		<string>$(xml_escape "$readback_highest_build")</string>
	</dict>
	<key>toolchain</key>
	<dict>
		<key>xcodeVersion</key>
		<string>$(xml_escape "$xcode_version")</string>
		<key>xcodeBuild</key>
		<string>$(xml_escape "$xcode_build")</string>
		<key>iphoneosSdkVersion</key>
		<string>$(xml_escape "$iphoneos_sdk_version")</string>
	</dict>
	<key>releaseGraph</key>
	<dict>
		<key>team</key>
		<string>$EXPECTED_TEAM</string>
		<key>appBundleId</key>
		<string>$APP_BUNDLE_ID</string>
		<key>appProfile</key>
		<string>$APP_PROFILE</string>
		<key>shareBundleId</key>
		<string>$SHARE_BUNDLE_ID</string>
		<key>shareProfile</key>
		<string>$SHARE_PROFILE</string>
		<key>exportDestination</key>
		<string>$EXPORT_DESTINATION</string>
		<key>exportMethod</key>
		<string>$EXPORT_METHOD</string>
		<key>signingStyle</key>
		<string>$EXPORT_SIGNING_STYLE</string>
		<key>manageAppVersionAndBuildNumber</key>
		<false/>
	</dict>
	<key>artifacts</key>
	<dict>
		<key>archivePath</key>
		<string>$(xml_escape "$archive_path")</string>
		<key>archivedAppBinarySha256</key>
		<string>$(xml_escape "$archive_binary_sha256")</string>
		<key>ipaPath</key>
		<string>$(xml_escape "$ipa_path")</string>
		<key>ipaSha256</key>
		<string>$(xml_escape "$ipa_sha256")</string>
		<key>exportOptionsPath</key>
		<string>$(xml_escape "$export_options")</string>
		<key>exportOptionsSha256</key>
		<string>$(xml_escape "$export_options_sha256")</string>
		<key>archiveLog</key>
		<string>$(xml_escape "$archive_log")</string>
		<key>exportLog</key>
		<string>$(xml_escape "$export_log")</string>
	</dict>
	<key>avCaptureUndefinedSymbols</key>
	<dict>
		<key>appCount</key>
		<integer>$app_avcapture_count</integer>
		<key>webrtcCount</key>
		<integer>$webrtc_avcapture_count</integer>
	</dict>
	<key>verificationFindings</key>
	<integer>$verify_failures</integer>
</dict>
</plist>
MANIFEST_PLIST

plutil -lint "$manifest_plist" >/dev/null ||
  build_failed "the generated manifest is not a valid plist: $manifest_plist"
plutil -convert json -o "$manifest_json" "$manifest_plist" ||
  build_failed "could not convert $manifest_plist to JSON"

note "wrote $manifest_txt"
note "wrote $manifest_plist"
note "wrote $manifest_json"

if [ "$verify_failures" -ne 0 ]; then
  printf '\n%s verification finding(s); the candidate and every log are preserved under %s\n' \
    "$verify_failures" "$artifact_root" >&2
  exit "$EXIT_VERIFY_FAILED"
fi

step 'candidate ready'
note "$marketing_version ($build_number) from $short_sha"
note "ipa    $ipa_path"
note "sha256 $ipa_sha256"
note ''
note 'This candidate has not been uploaded and consumed no App Store Connect'
note 'build number. Uploading it is a separate, separately authorized step.'
