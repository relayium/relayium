#!/bin/bash

set -Eeuo pipefail

script_dir="$(cd "$(dirname "$0")" && pwd -P)"
work_dir="$(mktemp -d "${TMPDIR:-/tmp}/relayium-notary-test.XXXXXX")"
trap 'rm -rf "$work_dir"' EXIT INT TERM

mock_bin="$work_dir/bin"
mkdir -p "$mock_bin"

cat > "$mock_bin/hdiutil" <<'EOF'
#!/bin/bash
set -euo pipefail
test "$1" = "verify"
test -f "$2"
EOF

cat > "$mock_bin/codesign" <<'EOF'
#!/bin/bash
set -euo pipefail
if [ "$1" = "-d" ]; then
  if [ "${MOCK_UNSIGNED:-false}" = true ]; then
    printf 'Signature=adhoc\n'
    exit 0
  fi
  printf 'Timestamp=Jul 31, 2026 at 09:00:00\n'
fi
EOF

cat > "$mock_bin/spctl" <<'EOF'
#!/bin/bash
set -euo pipefail
test "$1" = "--assess"
EOF

cat > "$mock_bin/xcrun" <<'EOF'
#!/bin/bash
set -euo pipefail

case "$1 $2" in
  "notarytool submit")
    printf '{"id":"11111111-2222-3333-4444-555555555555","status":"%s"}\n' \
      "${MOCK_NOTARY_STATUS:-Accepted}"
    ;;
  "notarytool log")
    printf '{"status":"%s","issues":[]}\n' \
      "${MOCK_NOTARY_STATUS:-Accepted}" > "$4"
    ;;
  "stapler staple")
    printf 'stapled-ticket\n' >> "$3"
    ;;
  "stapler validate")
    test -f "$3"
    ;;
  *)
    echo "unexpected xcrun invocation: $*" >&2
    exit 1
    ;;
esac
EOF

chmod +x "$mock_bin/codesign" "$mock_bin/hdiutil" "$mock_bin/spctl" "$mock_bin/xcrun"

key="$work_dir/AuthKey_TEST.p8"
printf 'private-key-placeholder\n' > "$key"

accepted_dmg="$work_dir/accepted.dmg"
accepted_evidence="$work_dir/accepted-evidence"
printf 'signed-dmg\n' > "$accepted_dmg"
mkdir "$accepted_evidence"

PATH="$mock_bin:$PATH" \
MACOS_NOTARY_KEY_PATH="$key" \
MACOS_NOTARY_KEY_ID="TESTKEY1234" \
MACOS_NOTARY_ISSUER_ID="11111111-2222-3333-4444-555555555555" \
  "$script_dir/notarize-dmg.sh" "$accepted_dmg" "$accepted_evidence"

test -s "$accepted_evidence/submission.json"
test -s "$accepted_evidence/notarization-log.json"
test -s "$accepted_dmg.sha256"
expected_checksum="$(shasum -a 256 "$accepted_dmg" | awk '{print $1}')"
actual_checksum="$(awk '{print $1}' "$accepted_dmg.sha256")"
test "$actual_checksum" = "$expected_checksum"

rejected_dmg="$work_dir/rejected.dmg"
rejected_evidence="$work_dir/rejected-evidence"
printf 'signed-dmg\n' > "$rejected_dmg"
mkdir "$rejected_evidence"

set +e
PATH="$mock_bin:$PATH" \
MOCK_NOTARY_STATUS="Invalid" \
MACOS_NOTARY_KEY_PATH="$key" \
MACOS_NOTARY_KEY_ID="TESTKEY1234" \
MACOS_NOTARY_ISSUER_ID="11111111-2222-3333-4444-555555555555" \
  "$script_dir/notarize-dmg.sh" "$rejected_dmg" "$rejected_evidence"
result=$?
set -e

test "$result" -eq 65
test -s "$rejected_evidence/submission.json"
test -s "$rejected_evidence/notarization-log.json"
test ! -e "$rejected_dmg.sha256"
test "$(cat "$rejected_dmg")" = "signed-dmg"

unsigned_dmg="$work_dir/unsigned.dmg"
unsigned_evidence="$work_dir/unsigned-evidence"
printf 'unsigned-dmg\n' > "$unsigned_dmg"
mkdir "$unsigned_evidence"

set +e
PATH="$mock_bin:$PATH" \
MOCK_UNSIGNED=true \
MACOS_NOTARY_KEY_PATH="$key" \
MACOS_NOTARY_KEY_ID="TESTKEY1234" \
MACOS_NOTARY_ISSUER_ID="11111111-2222-3333-4444-555555555555" \
  "$script_dir/notarize-dmg.sh" "$unsigned_dmg" "$unsigned_evidence" \
  >"$work_dir/unsigned.stdout" 2>"$work_dir/unsigned.stderr"
result=$?
set -e

test "$result" -eq 65
grep -Fq "disk image has no secure timestamp" "$work_dir/unsigned.stderr"
test ! -e "$unsigned_evidence/submission.json"

echo "notarize-dmg tests passed"
