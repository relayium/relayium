#!/bin/bash

set -Eeuo pipefail

script_dir="$(cd "$(dirname "$0")" && pwd -P)"
work_dir="$(mktemp -d "${TMPDIR:-/tmp}/relayium-package-dmg-test.XXXXXX")"
trap 'rm -rf "$work_dir"' EXIT INT TERM

mock_bin="$work_dir/bin"
app="$work_dir/Relayium.app"
mkdir -p "$mock_bin" "$app/Contents"
printf '<plist/>\n' > "$app/Contents/Info.plist"

cat > "$mock_bin/plutil" <<'EOF'
#!/bin/bash
printf '%s\n' com.relayium.mac
EOF

cat > "$mock_bin/codesign" <<'EOF'
#!/bin/bash
if [ "${1:-}" = -d ]; then
  printf '%s\n' 'Timestamp=Aug 18, 2026 at 12:00:00' >&2
fi
exit 0
EOF

cat > "$mock_bin/ditto" <<'EOF'
#!/bin/bash
cp -R "$1" "$2"
EOF

cat > "$mock_bin/shasum" <<'EOF'
#!/bin/bash
printf '%s  %s\n' aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa "${@: -1}"
EOF

cat > "$mock_bin/sleep" <<'EOF'
#!/bin/bash
count=0
if [ -f "$FAKE_SLEEP_STATE" ]; then
  count="$(cat "$FAKE_SLEEP_STATE")"
fi
printf '%s\n' "$((count + 1))" > "$FAKE_SLEEP_STATE"
EOF

cat > "$mock_bin/hdiutil" <<'EOF'
#!/bin/bash
set -Eeuo pipefail

case "$1" in
  create)
    printf '%s\n' dmg > "${@: -1}"
    ;;
  verify)
    count=0
    if [ -f "$FAKE_HDIUTIL_STATE" ]; then
      count="$(cat "$FAKE_HDIUTIL_STATE")"
    fi
    count=$((count + 1))
    printf '%s\n' "$count" > "$FAKE_HDIUTIL_STATE"
    case "$FAKE_VERIFY_MODE" in
      transient-then-success)
        if [ "$count" -eq 1 ]; then
          echo 'hdiutil: verify failed - Resource temporarily unavailable' >&2
          exit 1
        fi
        echo 'verified'
        ;;
      persistent-transient)
        echo 'hdiutil: verify failed - Resource temporarily unavailable' >&2
        exit 1
        ;;
      permanent)
        echo 'hdiutil: verify failed - invalid checksum' >&2
        exit 1
        ;;
      *)
        echo "unexpected verify mode: $FAKE_VERIFY_MODE" >&2
        exit 2
        ;;
    esac
    ;;
  attach)
    mountpoint=
    while [ "$#" -gt 0 ]; do
      if [ "$1" = -mountpoint ]; then
        mountpoint="$2"
        break
      fi
      shift
    done
    [ -n "$mountpoint" ]
    mkdir -p "$mountpoint/Relayium.app"
    ln -s /Applications "$mountpoint/Applications"
    ;;
  detach)
    ;;
  *)
    echo "unexpected hdiutil command: $1" >&2
    exit 2
    ;;
esac
EOF

chmod +x "$mock_bin"/*

run_case() {
  local name="$1"
  local mode="$2"
  local expected_status="$3"
  local expected_verifies="$4"
  local expected_sleeps="$5"
  local output="$work_dir/$name/Relayium.dmg"
  local stdout="$work_dir/$name/stdout"
  local stderr="$work_dir/$name/stderr"
  local hdiutil_state="$work_dir/$name/hdiutil-count"
  local sleep_state="$work_dir/$name/sleep-count"
  local actual_status

  mkdir -p "$work_dir/$name"
  set +e
  PATH="$mock_bin:/usr/bin:/bin" \
    FAKE_VERIFY_MODE="$mode" \
    FAKE_HDIUTIL_STATE="$hdiutil_state" \
    FAKE_SLEEP_STATE="$sleep_state" \
    "$script_dir/package-dmg.sh" "$app" "$output" 'Developer ID Application' \
      >"$stdout" 2>"$stderr"
  actual_status=$?
  set -e

  [ "$actual_status" -eq "$expected_status" ]
  [ "$(cat "$hdiutil_state")" -eq "$expected_verifies" ]
  actual_sleeps=0
  if [ -f "$sleep_state" ]; then
    actual_sleeps="$(cat "$sleep_state")"
  fi
  [ "$actual_sleeps" -eq "$expected_sleeps" ]

  if [ "$expected_status" -eq 0 ]; then
    [ -f "$output" ]
    [ -f "$output.sha256" ]
  else
    [ ! -e "$output" ]
    [ ! -e "$output.sha256" ]
  fi
}

run_case transient transient-then-success 0 2 1
grep -Fq 'retrying (1/3)' "$work_dir/transient/stderr"

run_case exhausted persistent-transient 1 3 2
grep -Fq 'remained temporarily unavailable after 3 attempts' "$work_dir/exhausted/stderr"

run_case permanent permanent 1 1 0
grep -Fq 'invalid checksum' "$work_dir/permanent/stderr"
if grep -Fq retrying "$work_dir/permanent/stderr"; then
  echo 'a permanent verification failure was retried' >&2
  exit 1
fi

[ "$(grep -Fc 'verify_hdiutil_image "$dmg_work"' "$script_dir/package-dmg.sh")" -eq 1 ]
[ "$(grep -Fc 'verify_hdiutil_image "$dmg"' "$script_dir/notarize-dmg.sh")" -eq 2 ]

echo 'package-dmg tests passed'
