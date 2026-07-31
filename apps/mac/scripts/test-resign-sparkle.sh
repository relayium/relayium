#!/bin/bash

set -Eeuo pipefail

script_dir="$(cd "$(dirname "$0")" && pwd -P)"
work_dir="$(mktemp -d "${TMPDIR:-/tmp}/relayium-sparkle-sign-test.XXXXXX")"
work_dir="$(cd "$work_dir" && pwd -P)"
trap 'rm -rf "$work_dir"' EXIT INT TERM

mock_bin="$work_dir/bin"
mkdir -p "$mock_bin"

cat > "$mock_bin/plutil" <<'EOF'
#!/bin/bash
set -euo pipefail
printf '%s\n' "${MOCK_BUNDLE_ID:-com.relayium.mac}"
EOF

cat > "$mock_bin/codesign" <<'EOF'
#!/bin/bash
set -euo pipefail
printf '%s\n' "$*" >> "$MOCK_CODESIGN_LOG"
if [ "$1" = "-d" ]; then
  printf 'flags=0x10000(runtime)\n'
  printf 'TeamIdentifier=7PVYUG4YQS\n'
  printf 'Timestamp=Jul 31, 2026 at 09:00:00\n'
fi
EOF

chmod +x "$mock_bin/plutil" "$mock_bin/codesign"

app="$work_dir/Relayium.app"
sparkle="$app/Contents/Frameworks/Sparkle.framework/Versions/B"
mkdir -p \
  "$sparkle/XPCServices/Installer.xpc" \
  "$sparkle/XPCServices/Downloader.xpc" \
  "$sparkle/Updater.app"
touch \
  "$app/Contents/Info.plist" \
  "$sparkle/Autoupdate"

log="$work_dir/codesign.log"
PATH="$mock_bin:$PATH" MOCK_CODESIGN_LOG="$log" \
  "$script_dir/resign-sparkle.sh" "$app" "Developer ID Application"

test "$(wc -l < "$log" | tr -d ' ')" -eq 12
sed -n '1p' "$log" | grep -Fq -- \
  "--force --sign Developer ID Application --timestamp --options runtime $sparkle/XPCServices/Installer.xpc"
sed -n '2p' "$log" | grep -Fq -- \
  "--preserve-metadata=entitlements $sparkle/XPCServices/Downloader.xpc"
sed -n '5p' "$log" | grep -Fq -- \
  "--force --sign Developer ID Application --timestamp --options runtime $app/Contents/Frameworks/Sparkle.framework"
sed -n '6p' "$log" | grep -Fq -- \
  "--preserve-metadata=identifier,entitlements,requirements $app"
sed -n '7p' "$log" | grep -Fq -- "--verify --strict --verbose=2 $app"
if grep -Fq -- "--deep" "$log"; then
  echo "error: signing flow must never use --deep" >&2
  exit 1
fi

set +e
PATH="$mock_bin:$PATH" MOCK_CODESIGN_LOG="$work_dir/wrong-bundle.log" \
MOCK_BUNDLE_ID="com.example.other" \
  "$script_dir/resign-sparkle.sh" "$app" "Developer ID Application" \
  >"$work_dir/wrong-bundle.stdout" 2>"$work_dir/wrong-bundle.stderr"
result=$?
set -e

test "$result" -eq 65
grep -Fq "expected bundle identifier com.relayium.mac" \
  "$work_dir/wrong-bundle.stderr"
test ! -s "$work_dir/wrong-bundle.log"

echo "resign-sparkle tests passed"
