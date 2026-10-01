#!/usr/bin/env bash
# scripts/release/macos-evidence-verify-app.sh — are these the direct Developer
# ID bytes the provenance says they are?
#
#   macos-evidence-verify-app.sh <Relayium.dmg> <provenance.json> <generate_appcast> <mount-dir>
#
# Run by `macos-release.yml`'s notarization job on BOTH signed-build sources —
# a fresh build from this run and a reused build from the exact-main push run —
# after the download and before any secret is materialized or the restored
# `generate_appcast` is executed. `signed-build` proved all of this about the
# bytes it produced; a reused package crossed a run boundary since, so it is
# proven again here, against the bytes actually about to be notarized.
#
# The checks are the producer's, read off the mounted image:
#
#   * the DMG and the app are Developer ID signed by team 7PVYUG4YQS, strict,
#     hardened, timestamped — an Apple Distribution / Mac App Store signature,
#     or an unsigned App Store product, is refused;
#   * the app is the DIRECT channel: Sparkle embedded and enabled, the public
#     feed URL, an EdDSA key, the Sparkle installer entitlements — the App Store
#     product carries none of them and cannot pass as this one;
#   * app and Share extension are arm64 only, and each carries EXACTLY the
#     typed entitlement set of the real direct product — sandbox true, exact
#     App Group, keychain group, associated domain and Sparkle Mach names —
#     and nothing else (no get-task-allow, no extension network or keychain);
#   * both privacy manifests ship (`verify-privacy-manifests.sh … direct`);
#   * app and Share extension bundle identifiers, versions and builds equal the
#     provenance's, and the DMG and `generate_appcast` hash to it.
#
# Read-only: it mounts the image read-only and detaches it on every exit.
set -euo pipefail

dmg="${1:?usage: macos-evidence-verify-app.sh <dmg> <provenance.json> <generate_appcast> <mount-dir>}"
provenance="${2:?missing provenance.json}"
tool="${3:?missing generate_appcast}"
mount="${4:?missing mount directory}"

team=7PVYUG4YQS
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
scripts="$here/../../apps/mac/scripts"

fail() { echo "::error::$*" >&2; exit 1; }
field() { jq -er --arg k "$1" '.[$k] | strings' "$provenance" || fail "provenance.$1 is missing"; }
plist() { plutil -extract "$2" raw -o - "$1" 2>/dev/null || true; }

[ -f "$dmg" ] || fail "no DMG at $dmg"
[ -f "$tool" ] || fail "no generate_appcast at $tool"
[ "$(shasum -a 256 "$dmg" | awk '{print $1}')" = "$(field dmgSha256)" ] \
  || fail "the DMG does not hash to provenance.dmgSha256"
[ "$(shasum -a 256 "$tool" | awk '{print $1}')" = "$(field generateAppcastSha256)" ] \
  || fail "generate_appcast does not hash to provenance.generateAppcastSha256"
[ "$(field channel)" = direct ] || fail "provenance.channel is not direct"
[ "$(field arch)" = arm64 ] || fail "provenance.arch is not arm64"
version="$(field version)"
build="$(field build)"

# Developer ID, this team, hardened, timestamped — for one signed subject.
require_developer_id() {
  local subject="$1" details
  codesign --verify --strict --verbose=2 "$subject" || fail "signature does not verify: $subject"
  details="$(codesign -d --verbose=4 "$subject" 2>&1)" || fail "signature unreadable: $subject"
  printf '%s\n' "$details" | grep -q "^Authority=Developer ID Application: .*($team)\$" \
    || fail "not signed with a Developer ID Application identity of team $team: $subject"
  printf '%s\n' "$details" | grep -q "^TeamIdentifier=$team\$" || fail "team is not $team: $subject"
  printf '%s\n' "$details" | grep -q '^Timestamp=' || fail "no secure timestamp: $subject"
  printf '%s\n' "$details"
}

require_developer_id "$dmg" > /dev/null

mkdir -p "$mount"
attached=false
cleanup() { if [ "$attached" = true ]; then hdiutil detach "$mount" > /dev/null 2>&1 || true; fi; }
trap cleanup EXIT
hdiutil attach "$dmg" -mountpoint "$mount" -nobrowse -readonly > /dev/null
attached=true

app="$mount/Relayium.app"
appex="$app/Contents/PlugIns/RelayiumShare.appex"
[ -d "$app" ] || fail "the image holds no Relayium.app"
[ -d "$appex" ] || fail "the app embeds no Share extension"

codesign --verify --deep --strict --verbose=2 "$app" || fail "deep signature does not verify"
app_details="$(require_developer_id "$app")"
printf '%s\n' "$app_details" | grep -q 'flags=.*runtime' || fail "app lacks the Hardened Runtime"
appex_details="$(require_developer_id "$appex")"
printf '%s\n' "$appex_details" | grep -q 'flags=.*runtime' || fail "Share extension lacks the Hardened Runtime"

[ "$(plist "$app/Contents/Info.plist" CFBundleIdentifier)" = com.relayium.mac ] || fail "app bundle identifier is not com.relayium.mac"
[ "$(plist "$appex/Contents/Info.plist" CFBundleIdentifier)" = com.relayium.mac.Share ] || fail "Share extension bundle identifier is not com.relayium.mac.Share"
[ "$(plist "$app/Contents/Info.plist" CFBundleShortVersionString)" = "$version" ] || fail "app version is not provenance $version"
[ "$(plist "$app/Contents/Info.plist" CFBundleVersion)" = "$build" ] || fail "app build is not provenance $build"
[ "$(plist "$appex/Contents/Info.plist" CFBundleShortVersionString)" = "$version" ] || fail "Share extension version is not $version"
[ "$(plist "$appex/Contents/Info.plist" CFBundleVersion)" = "$build" ] || fail "Share extension build is not $build"
[ "$(field shareExtensionVersion)" = "$version" ] && [ "$(field shareExtensionBuild)" = "$build" ] \
  || fail "provenance names a different Share extension version/build"

# The direct channel, which the App Store product is not.
[ -d "$app/Contents/Frameworks/Sparkle.framework" ] || fail "no Sparkle: this is not the direct product"
[ "$(plist "$app/Contents/Info.plist" SUEnableInstallerLauncherService)" = true ] || fail "Sparkle Installer.xpc is not enabled"
[ "$(plist "$app/Contents/Info.plist" SUFeedURL)" = https://relayium.com/apps/macos/appcast.xml ] || fail "Sparkle feed URL is missing or unexpected"
[ -n "$(plist "$app/Contents/Info.plist" SUPublicEDKey)" ] || fail "Sparkle EdDSA public key is missing"

bash "$scripts/verify-apple-silicon.sh" "$app"

# Entitlements, TYPED and EXACT. Each signature's entitlements are converted to
# JSON (a plist holding a date or data blob fails the conversion and fails
# here) and compared to the complete set the direct Developer ID product is
# signed with — the baseline read off a real `main` signed-build (run
# 36883327742, job 110440631775). Every key must be present with exactly this
# type and value, and no other key may appear: a `<false/>` sandbox, a string
# where an array belongs, a foreign App Group, a network grant on the Share
# extension or any added privilege (get-task-allow, Sign in with Apple, a
# keychain group on the extension) is refused by name. Arrays compare as sets
# of their sorted elements, so a duplicate is a difference too.
app_entitlements_want="$(jq -cn --arg team "$team" '{
  "com.apple.application-identifier": ($team + ".com.relayium.mac"),
  "com.apple.developer.team-identifier": $team,
  "com.apple.security.app-sandbox": true,
  "com.apple.security.application-groups": [($team + ".com.relayium.shared")],
  "keychain-access-groups": [($team + ".com.relayium.shared")],
  "com.apple.developer.associated-domains": ["applinks:relayium.com"],
  "com.apple.security.network.client": true,
  "com.apple.security.network.server": true,
  "com.apple.security.files.user-selected.read-write": true,
  "com.apple.security.files.downloads.read-write": true,
  "com.apple.security.temporary-exception.mach-lookup.global-name": ["com.relayium.mac-spks", "com.relayium.mac-spki"]
}')"
appex_entitlements_want="$(jq -cn --arg team "$team" '{
  "com.apple.application-identifier": ($team + ".com.relayium.mac.Share"),
  "com.apple.developer.team-identifier": $team,
  "com.apple.security.app-sandbox": true,
  "com.apple.security.application-groups": [($team + ".com.relayium.shared")]
}')"
require_entitlements() {
  local label="$1" subject="$2" want="$3" got problems
  got="$(codesign -d --entitlements - --xml "$subject" | plutil -convert json -o - -)" \
    || fail "$label entitlements are not a plain typed plist"
  problems="$(jq -rn --argjson got "$got" --argjson want "$want" '
    def canon: if type == "array" then sort else . end;
    if ($got | type) != "object" then "the entitlements are a \($got | type), not a dictionary"
    else
      ([($got | keys - ($want | keys))[] | "carries unpermitted entitlement \(.)"]
      + [($want | keys - ($got | keys))[] | "lacks entitlement \(.)"]
      + [($want | keys)[] as $k | select($got | has($k))
          | if ($got[$k] | type) != ($want[$k] | type)
            then "\($k) is a \($got[$k] | type), want \($want[$k] | type) \($want[$k] | tojson)"
            elif ($got[$k] | canon) != ($want[$k] | canon)
            then "\($k) is \($got[$k] | tojson), want \($want[$k] | tojson)"
            else empty end])
      | .[]
    end')" || fail "$label entitlements could not be compared"
  [ -z "$problems" ] || fail "$label entitlements: $(printf '%s' "$problems" | paste -sd ';' -)"
}
require_entitlements "app" "$app" "$app_entitlements_want"
require_entitlements "Share extension" "$appex" "$appex_entitlements_want"

bash "$scripts/verify-privacy-manifests.sh" "$app" direct

echo "verified direct Developer ID package $version ($build), team $team, arm64"
