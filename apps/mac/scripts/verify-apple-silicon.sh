#!/bin/bash
# Verify that a built Relayium.app is Apple Silicon only: its own executable and
# the executable of every embedded app extension carry exactly one architecture,
# `arm64`. A fat (arm64 + x86_64) or Intel-only executable is REJECTED, not
# tolerated — from 1.4.0 (37) the product does not run on Intel Macs, and a
# release that quietly shipped a universal binary would make every
# "Apple Silicon only" statement and the Sparkle feed's arm64 requirement
# disagree with the bytes.
#
# Deliberately the MAIN executables and not every Mach-O in the bundle. The
# prebuilt Sparkle and WebRTC frameworks arrive as universal binaries and are
# not rebuilt by ARCHS; an Intel Mac cannot launch the app whatever those
# frameworks contain. It is also exactly the file Sparkle's `generate_appcast`
# reads to decide whether an item needs `<sparkle:hardwareRequirements>arm64`.
#
# Usage: verify-apple-silicon.sh <path/to/Relayium.app>
set -euo pipefail

app="${1:?usage: verify-apple-silicon.sh <Relayium.app>}"
[ -d "$app" ] || { echo "error: not an app bundle: $app" >&2; exit 1; }

executable_of() {
  local bundle="$1" name
  name="$(plutil -extract CFBundleExecutable raw -o - "$bundle/Contents/Info.plist" 2>/dev/null)" || {
    echo "error: $bundle has no CFBundleExecutable" >&2; return 1; }
  [ -n "$name" ] && [ "${name#*/}" = "$name" ] || {
    echo "error: $bundle names an unusable executable: $name" >&2; return 1; }
  printf '%s\n' "$bundle/Contents/MacOS/$name"
}

require_arm64_only() {
  local binary="$1" archs
  [ -f "$binary" ] || { echo "error: executable is missing: $binary" >&2; return 1; }
  archs="$(lipo -archs "$binary" 2>/dev/null)" || {
    echo "error: not a Mach-O executable: $binary" >&2; return 1; }
  if [ "$archs" != "arm64" ]; then
    echo "error: $binary is not Apple Silicon only (architectures: $archs)" >&2
    return 1
  fi
  echo "arm64 only: $binary"
}

require_arm64_only "$(executable_of "$app")"

extensions=0
shopt -s nullglob
for appex in "$app"/Contents/PlugIns/*.appex; do
  require_arm64_only "$(executable_of "$appex")"
  extensions=$((extensions + 1))
done
# Every shipped Relayium product embeds its Share extension. An app with none
# is not the product this gate is for, and passing it would let a build that
# lost its extension vouch for an architecture it never checked.
[ "$extensions" -ge 1 ] || { echo "error: $app embeds no app extension" >&2; exit 1; }
echo "Apple Silicon only: $app (+$extensions extension(s))"
