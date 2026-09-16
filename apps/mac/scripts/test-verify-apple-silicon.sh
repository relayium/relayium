#!/bin/bash
# Adversarial cases for verify-apple-silicon.sh, on real Mach-O executables
# compiled here for each architecture set.
set -Eeuo pipefail

script_dir="$(cd "$(dirname "$0")" && pwd -P)"
verify="$script_dir/verify-apple-silicon.sh"
work="$(mktemp -d "${TMPDIR:-/tmp}/relayium-apple-silicon.XXXXXX")"
trap 'rm -rf "$work"' EXIT INT TERM

printf 'int main(void){return 0;}\n' > "$work/main.c"
compile() { # <out> <arch>...
  local out="$1"; shift
  local flags=()
  for arch in "$@"; do flags+=(-arch "$arch"); done
  xcrun clang "${flags[@]}" -o "$out" "$work/main.c"
}
compile "$work/arm64" arm64
compile "$work/x86_64" x86_64
compile "$work/fat" arm64 x86_64

bundle() { # <dir> <executable-source>
  mkdir -p "$1/Contents/MacOS"
  cp "$2" "$1/Contents/MacOS/Relayium"
  plutil -create xml1 "$1/Contents/Info.plist"
  plutil -insert CFBundleExecutable -string Relayium "$1/Contents/Info.plist"
}
product() { # <name> <app-executable> <appex-executable|none>
  local app="$work/$1/Relayium.app"
  bundle "$app" "$2"
  if [ "$3" != none ]; then bundle "$app/Contents/PlugIns/RelayiumShare.appex" "$3"; fi
  printf '%s\n' "$app"
}

pass() { "$verify" "$1" >/dev/null 2>&1 || { echo "FAIL: expected pass: $2" >&2; exit 1; }; }
reject() { if "$verify" "$1" >/dev/null 2>&1; then echo "FAIL: expected rejection: $2" >&2; exit 1; fi; }

pass "$(product ok "$work/arm64" "$work/arm64")" "arm64 app with arm64 extension"
reject "$(product fat-app "$work/fat" "$work/arm64")" "universal app executable"
reject "$(product intel-app "$work/x86_64" "$work/arm64")" "Intel-only app executable"
reject "$(product fat-appex "$work/arm64" "$work/fat")" "universal Share extension"
reject "$(product intel-appex "$work/arm64" "$work/x86_64")" "Intel-only Share extension"
reject "$(product no-appex "$work/arm64" none)" "app with no extension"
missing="$(product missing "$work/arm64" "$work/arm64")"; rm "$missing/Contents/MacOS/Relayium"
reject "$missing" "missing app executable"
notmacho="$(product notmacho "$work/arm64" "$work/arm64")"; printf 'text' > "$notmacho/Contents/MacOS/Relayium"
reject "$notmacho" "non-Mach-O executable"
reject "$work/nothing.app" "not a bundle"

echo "verify-apple-silicon tests passed"
