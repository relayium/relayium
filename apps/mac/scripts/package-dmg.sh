#!/bin/bash

set -Eeuo pipefail

usage() {
  echo "Usage: $0 /path/to/Relayium.app /path/to/Relayium.dmg" >&2
}

if [ "$#" -ne 2 ]; then
  usage
  exit 64
fi

app_input="$1"
output_input="$2"

if [ ! -d "$app_input" ] || [ "${app_input##*.}" != "app" ]; then
  echo "error: app input must be an existing .app bundle: $app_input" >&2
  exit 66
fi

if [ "${output_input##*.}" != "dmg" ]; then
  echo "error: output must end in .dmg: $output_input" >&2
  exit 64
fi

output_parent="$(dirname "$output_input")"
if [ ! -d "$output_parent" ]; then
  echo "error: output directory does not exist: $output_parent" >&2
  exit 73
fi

app="$(cd "$(dirname "$app_input")" && pwd -P)/$(basename "$app_input")"
output="$(cd "$output_parent" && pwd -P)/$(basename "$output_input")"

if [ -e "$output" ] || [ -L "$output" ] || [ -e "$output.sha256" ]; then
  echo "error: refusing to overwrite an existing package or checksum: $output" >&2
  exit 73
fi

info_plist="$app/Contents/Info.plist"
if [ ! -f "$info_plist" ]; then
  echo "error: app bundle has no Contents/Info.plist: $app" >&2
  exit 65
fi

bundle_id="$(plutil -extract CFBundleIdentifier raw -o - "$info_plist")"
if [ "$bundle_id" != "com.relayium.mac" ]; then
  echo "error: expected bundle identifier com.relayium.mac, got $bundle_id" >&2
  exit 65
fi

codesign --verify --strict --verbose=2 "$app"
signature_details="$(codesign -d --verbose=4 "$app" 2>&1)"
if ! printf '%s\n' "$signature_details" | grep -q '^Timestamp='; then
  echo "error: app signature has no secure timestamp" >&2
  exit 65
fi

work_dir="$(mktemp -d "${TMPDIR:-/tmp}/relayium-dmg.XXXXXX")"
stage_dir="$work_dir/stage"
mount_dir="$work_dir/mount"
dmg_work="$work_dir/Relayium.dmg"
checksum_work="$work_dir/Relayium.dmg.sha256"
mounted=false

cleanup() {
  if [ "$mounted" = true ]; then
    hdiutil detach "$mount_dir" >/dev/null 2>&1 || true
  fi
  rm -rf "$work_dir"
}
trap cleanup EXIT INT TERM

mkdir -p "$stage_dir" "$mount_dir"
ditto "$app" "$stage_dir/Relayium.app"
ln -s /Applications "$stage_dir/Applications"

hdiutil create \
  -volname "Relayium" \
  -srcfolder "$stage_dir" \
  -format UDZO \
  "$dmg_work"
hdiutil verify "$dmg_work"

hdiutil attach \
  -readonly \
  -nobrowse \
  -mountpoint "$mount_dir" \
  "$dmg_work" >/dev/null
mounted=true

if [ "$(readlink "$mount_dir/Applications")" != "/Applications" ]; then
  echo "error: mounted image is missing the Applications shortcut" >&2
  exit 65
fi
codesign --verify --strict --verbose=2 "$mount_dir/Relayium.app"

hdiutil detach "$mount_dir" >/dev/null
mounted=false

output_name="$(basename "$output")"
checksum="$(shasum -a 256 "$dmg_work" | awk '{print $1}')"
printf '%s  %s\n' "$checksum" "$output_name" > "$checksum_work"

# Keep the named output absent until all validation has passed, so a failed
# packaging attempt cannot be mistaken for a releasable image.
mv "$checksum_work" "$output.sha256"
mv "$dmg_work" "$output"

echo "Created $output"
echo "Checksum $output.sha256"
