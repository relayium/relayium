#!/bin/bash
# Verify the privacy manifests INSIDE a built Relayium.app — the app's own and
# the embedded Share extension's.
#
# Both macOS folders are synchronized, so bundle membership is a filesystem fact
# rather than a project edit: a manifest dropped from a target produces no diff,
# no build failure and no runtime symptom, just a rejected upload. And shipping
# the app's manifest inside the appex (or the reverse) passes every existence
# check while being a false statement about a process that never reaches the
# network — hence the exact per-bundle sets below.
#
# Usage: verify-privacy-manifests.sh <path/to/Relayium.app> <channel label>
set -euo pipefail

app="${1:?usage: verify-privacy-manifests.sh <Relayium.app> <channel>}"
channel="${2:?usage: verify-privacy-manifests.sh <Relayium.app> <channel>}"
appex="$app/Contents/PlugIns/RelayiumShare.appex"

# The app's set, in file order. Every entry is traced to a call site and a
# retained server column in the manifest's own comments.
app_types=(
  NSPrivacyCollectedDataTypeName
  NSPrivacyCollectedDataTypeEmailAddress
  NSPrivacyCollectedDataTypePurchaseHistory
  NSPrivacyCollectedDataTypeUserID
  NSPrivacyCollectedDataTypeDeviceID
  NSPrivacyCollectedDataTypeOtherUsageData
)

fail() { echo "::error::$channel: $*"; exit 1; }

get() { plutil -extract "$2" raw -o - "$1"; }

# Existence, validity and the tracking answer, for both bundles.
for manifest in "$app/Contents/Resources/PrivacyInfo.xcprivacy" \
                "$appex/Contents/Resources/PrivacyInfo.xcprivacy"; do
  [ -f "$manifest" ] || fail "privacy manifest missing from the built product: $manifest"
  plutil -lint "$manifest"
  [ "$(get "$manifest" NSPrivacyTracking)" = false ] || fail "built manifest declares tracking: $manifest"
  [ "$(get "$manifest" NSPrivacyTrackingDomains)" = 0 ] || fail "built manifest names a tracking domain: $manifest"
done

# The app: exactly these types, each linked, none tracking, all App Functionality.
m="$app/Contents/Resources/PrivacyInfo.xcprivacy"
[ "$(get "$m" NSPrivacyCollectedDataTypes)" = "${#app_types[@]}" ] \
  || fail "the app's manifest does not declare exactly ${#app_types[@]} collected data types"
for i in "${!app_types[@]}"; do
  want="${app_types[$i]}"
  [ "$(get "$m" "NSPrivacyCollectedDataTypes.$i.NSPrivacyCollectedDataType")" = "$want" ] \
    || fail "the app's collected data type $i is not $want"
  [ "$(get "$m" "NSPrivacyCollectedDataTypes.$i.NSPrivacyCollectedDataTypeLinked")" = true ] \
    || fail "$want is not declared as linked to the user"
  [ "$(get "$m" "NSPrivacyCollectedDataTypes.$i.NSPrivacyCollectedDataTypeTracking")" = false ] \
    || fail "$want is declared as used for tracking"
  [ "$(get "$m" "NSPrivacyCollectedDataTypes.$i.NSPrivacyCollectedDataTypePurposes.0")" \
    = NSPrivacyCollectedDataTypePurposeAppFunctionality ] \
    || fail "$want is declared for a purpose other than App Functionality"
done
[ "$(get "$m" NSPrivacyAccessedAPITypes)" = 3 ] \
  || fail "the app's manifest does not declare its three required-reason APIs"

# The extension: it reaches no network, so it collects nothing, and it links only
# RelayiumShareKit, so it uses one required-reason API.
m="$appex/Contents/Resources/PrivacyInfo.xcprivacy"
[ "$(get "$m" NSPrivacyCollectedDataTypes)" = 0 ] \
  || fail "the Share extension's manifest claims to collect something"
[ "$(get "$m" NSPrivacyAccessedAPITypes)" = 1 ] \
  || fail "the Share extension ships the app's manifest, not its own"

echo "$channel: both privacy manifests present, valid and exact"
