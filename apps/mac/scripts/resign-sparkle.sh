#!/bin/bash

set -Eeuo pipefail

usage() {
  echo "Usage: $0 /path/to/Relayium.app 'Developer ID Application: Name (TEAMID)'" >&2
}

if [ "$#" -ne 2 ]; then
  usage
  exit 64
fi

app_input="$1"
identity="$2"

if [ ! -d "$app_input" ] || [ "${app_input##*.}" != "app" ]; then
  echo "error: app input must be an existing .app bundle: $app_input" >&2
  exit 66
fi

if [ -z "$identity" ]; then
  echo "error: signing identity must not be empty" >&2
  exit 64
fi

app="$(cd "$(dirname "$app_input")" && pwd -P)/$(basename "$app_input")"
info_plist="$app/Contents/Info.plist"
sparkle="$app/Contents/Frameworks/Sparkle.framework"

if [ ! -f "$info_plist" ]; then
  echo "error: app bundle has no Contents/Info.plist: $app" >&2
  exit 65
fi

bundle_id="$(plutil -extract CFBundleIdentifier raw -o - "$info_plist")"
if [ "$bundle_id" != "com.relayium.mac" ]; then
  echo "error: expected bundle identifier com.relayium.mac, got $bundle_id" >&2
  exit 65
fi

if [ ! -d "$sparkle" ]; then
  echo "error: app bundle has no embedded Sparkle.framework" >&2
  exit 65
fi

version="$sparkle/Versions/B"
installer="$version/XPCServices/Installer.xpc"
downloader="$version/XPCServices/Downloader.xpc"
autoupdate="$version/Autoupdate"
updater="$version/Updater.app"

for item in "$installer" "$downloader" "$autoupdate" "$updater"; do
  if [ ! -e "$item" ]; then
    echo "error: Sparkle distribution component is missing: $item" >&2
    exit 65
  fi
done

# Sparkle documents this leaf-to-root order for non-Archive/Export release
# workflows. Downloader.xpc has an entitlement that must not leak to the other
# helpers, which is why --deep is deliberately never used.
codesign --force --sign "$identity" --timestamp --options runtime "$installer"
codesign --force --sign "$identity" --timestamp --options runtime \
  --preserve-metadata=entitlements "$downloader"
codesign --force --sign "$identity" --timestamp --options runtime "$autoupdate"
codesign --force --sign "$identity" --timestamp --options runtime "$updater"
codesign --force --sign "$identity" --timestamp --options runtime "$sparkle"

# Re-sign the containing app because changing nested code invalidates its
# resource seal. Preserve the profile-expanded sandbox, Keychain, and
# Associated Domains entitlements created by Xcode.
codesign --force --sign "$identity" --timestamp --options runtime \
  --preserve-metadata=identifier,entitlements,requirements "$app"

codesign --verify --strict --verbose=2 "$app"

for item in "$installer" "$downloader" "$autoupdate" "$updater" "$sparkle"; do
  details="$(codesign -d --verbose=4 "$item" 2>&1)"
  if printf '%s\n' "$details" | grep -q 'flags=.*adhoc'; then
    echo "error: Sparkle component is still ad-hoc signed: $item" >&2
    exit 65
  fi
  if ! printf '%s\n' "$details" | grep -q '^Timestamp='; then
    echo "error: Sparkle component has no secure timestamp: $item" >&2
    exit 65
  fi
done

echo "Re-signed Sparkle distribution components in $app"
