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

# A virtual clock keeps every deadline assertion instant and deterministic. Only
# `date +%s` is faked, so any other date usage keeps real behavior.
cat > "$mock_bin/date" <<'EOF'
#!/bin/bash
if [ "$#" -eq 1 ] && [ "$1" = '+%s' ]; then
  if [ -f "${FAKE_CLOCK_STATE:-}" ]; then
    cat "$FAKE_CLOCK_STATE"
  else
    printf '%s\n' 0
  fi
  exit 0
fi
exec /bin/date "$@"
EOF

# Record every requested duration in order and advance the virtual clock by it,
# so the retry schedule can be asserted exactly without any real waiting. The
# frozen-clock cases keep the recording but suppress the advance.
cat > "$mock_bin/sleep" <<'EOF'
#!/bin/bash
duration="${1:-0}"
printf '%s\n' "$duration" >> "$FAKE_SLEEP_STATE"
if [ "${FAKE_CLOCK_ADVANCES:-1}" = 1 ]; then
  clock=0
  if [ -f "$FAKE_CLOCK_STATE" ]; then
    clock="$(cat "$FAKE_CLOCK_STATE")"
  fi
  printf '%s\n' "$((clock + duration))" > "$FAKE_CLOCK_STATE"
fi
EOF

cat > "$mock_bin/mount" <<'EOF'
#!/bin/bash
count=0
if [ -f "$FAKE_MOUNT_STATE" ]; then
  count="$(cat "$FAKE_MOUNT_STATE")"
fi
printf '%s\n' "$((count + 1))" > "$FAKE_MOUNT_STATE"
printf '%s\n' '/dev/disk4s1 on /Volumes/Relayium (hfs, local, nodev, read-only)'
EOF

cat > "$mock_bin/lsof" <<'EOF'
#!/bin/bash
count=0
if [ -f "$FAKE_LSOF_STATE" ]; then
  count="$(cat "$FAKE_LSOF_STATE")"
fi
printf '%s\n' "$((count + 1))" > "$FAKE_LSOF_STATE"
printf '%s\n' 'COMMAND PID USER FD TYPE DEVICE SIZE/OFF NODE NAME'
exit 1
EOF

cat > "$mock_bin/hdiutil" <<'EOF'
#!/bin/bash
set -Eeuo pipefail

case "$1" in
  create)
    printf '%s\n' dmg > "${@: -1}"
    ;;
  info)
    count=0
    if [ -f "$FAKE_HDIUTIL_INFO_STATE" ]; then
      count="$(cat "$FAKE_HDIUTIL_INFO_STATE")"
    fi
    printf '%s\n' "$((count + 1))" > "$FAKE_HDIUTIL_INFO_STATE"
    printf '%s\n' 'framework       : 594'
    ;;
  verify)
    count=0
    if [ -f "$FAKE_HDIUTIL_STATE" ]; then
      count="$(cat "$FAKE_HDIUTIL_STATE")"
    fi
    count=$((count + 1))
    printf '%s\n' "$count" > "$FAKE_HDIUTIL_STATE"
    fail_status="${FAKE_VERIFY_STATUS:-1}"
    case "$FAKE_VERIFY_MODE" in
      transient-until)
        if [ "$count" -le "${FAKE_TRANSIENT_FAILURES:-1}" ]; then
          echo 'hdiutil: verify failed - Resource temporarily unavailable' >&2
          exit "$fail_status"
        fi
        echo 'verified'
        ;;
      persistent-transient)
        echo 'hdiutil: verify failed - Resource temporarily unavailable' >&2
        exit "$fail_status"
        ;;
      permanent)
        echo 'hdiutil: verify failed - invalid checksum' >&2
        exit "$fail_status"
        ;;
      transient-detail)
        # hdiutil may append an errno detail to the same readiness reason.
        if [ "$count" -le "${FAKE_TRANSIENT_FAILURES:-1}" ]; then
          echo 'hdiutil: verify failed - Resource temporarily unavailable (35)' >&2
          exit "$fail_status"
        fi
        echo 'verified'
        ;;
      phrase-path-suffix)
        # The phrase opens the reason but continues into a path, so it is a
        # name rather than the transient condition itself.
        echo 'hdiutil: verify failed - Resource temporarily unavailable/Relayium.dmg' >&2
        exit "$fail_status"
        ;;
      path-lookalike)
        # The retryable phrase appears only inside a path, so hdiutil's actual
        # failure reason is permanent and must not be retried.
        echo 'hdiutil: verify failed - No such file or directory: /Volumes/Resource temporarily unavailable/Relayium.dmg' >&2
        exit "$fail_status"
        ;;
      unprefixed-phrase)
        # The phrase without hdiutil's own failed-operation prefix is not a
        # readiness signal, whichever tool emitted it.
        echo 'Resource temporarily unavailable' >&2
        echo 'diskarbitrationd: Resource temporarily unavailable' >&2
        echo 'hdiutil: verify failed - checksum mismatch' >&2
        exit "$fail_status"
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

failures=0

fail() {
  echo "FAIL: $*" >&2
  failures=$((failures + 1))
}

# Build a space-separated schedule such as "8 8 8" without needing seq.
repeat_token() {
  local token="$1"
  local times="$2"
  local out=''
  local i=0

  while [ "$i" -lt "$times" ]; do
    out="$out $token"
    i=$((i + 1))
  done

  printf '%s' "${out# }"
}

read_counter() {
  local path="$1"

  if [ -f "$path" ]; then
    cat "$path"
  else
    printf '%s\n' 0
  fi
}

# Extra environment for the next run_case invocation, reset after every case.
case_env=()

run_case() {
  local name="$1"
  local mode="$2"
  local expected_status="$3"
  local expected_verifies="$4"
  local expected_sleeps="$5"
  local case_dir="$work_dir/$name"
  local output="$case_dir/Relayium.dmg"
  local stdout="$case_dir/stdout"
  local stderr="$case_dir/stderr"
  local actual_status
  local actual_verifies
  local actual_sleeps
  local hdiutil_state="$case_dir/hdiutil-count"
  local hdiutil_info_state="$case_dir/hdiutil-info-count"
  local sleep_state="$case_dir/sleep-log"
  local clock_state="$case_dir/clock"
  local mount_state="$case_dir/mount-count"
  local lsof_state="$case_dir/lsof-count"

  mkdir -p "$case_dir"
  printf '%s\n' 0 > "$clock_state"

  set +e
  env \
    PATH="$mock_bin:/usr/bin:/bin" \
    FAKE_VERIFY_MODE="$mode" \
    FAKE_HDIUTIL_STATE="$hdiutil_state" \
    FAKE_HDIUTIL_INFO_STATE="$hdiutil_info_state" \
    FAKE_SLEEP_STATE="$sleep_state" \
    FAKE_CLOCK_STATE="$clock_state" \
    FAKE_MOUNT_STATE="$mount_state" \
    FAKE_LSOF_STATE="$lsof_state" \
    ${case_env[@]+"${case_env[@]}"} \
    "$script_dir/package-dmg.sh" "$app" "$output" 'Developer ID Application' \
      >"$stdout" 2>"$stderr"
  actual_status=$?
  set -e

  case_env=()

  if [ "$actual_status" -ne "$expected_status" ]; then
    fail "$name: exit status $actual_status, expected $expected_status"
  fi

  actual_verifies="$(read_counter "$hdiutil_state")"
  if [ "$actual_verifies" -ne "$expected_verifies" ]; then
    fail "$name: $actual_verifies hdiutil verify calls, expected $expected_verifies"
  fi

  actual_sleeps=''
  if [ -f "$sleep_state" ]; then
    actual_sleeps="$(tr '\n' ' ' < "$sleep_state")"
    actual_sleeps="${actual_sleeps% }"
  fi
  if [ "$actual_sleeps" != "$expected_sleeps" ]; then
    fail "$name: sleep schedule [$actual_sleeps], expected [$expected_sleeps]"
  fi

  # A failed packaging attempt must never leave a releasable-looking artifact.
  if [ "$expected_status" -eq 0 ]; then
    if [ ! -f "$output" ] || [ ! -f "$output.sha256" ]; then
      fail "$name: successful packaging did not produce the image and checksum"
    fi
  else
    if [ -e "$output" ] || [ -e "$output.sha256" ]; then
      fail "$name: failed packaging left an output artifact behind"
    fi
  fi
}

assert_diagnostics() {
  local name="$1"
  local expected="$2"
  local actual
  local state

  for state in "$work_dir/$name/mount-count" "$work_dir/$name/lsof-count" \
    "$work_dir/$name/hdiutil-info-count"; do
    actual="$(read_counter "$state")"
    if [ "$actual" -ne "$expected" ]; then
      fail "$name: $(basename "$state") is $actual, expected $expected"
    fi
  done
}

assert_contains() {
  local path="$1"
  local needle="$2"

  if ! grep -Fq "$needle" "$path"; then
    fail "$path does not contain: $needle"
  fi
}

assert_absent() {
  local path="$1"
  local needle="$2"

  if grep -Fq "$needle" "$path"; then
    fail "$path unexpectedly contains: $needle"
  fi
}

# 1s, 2s, 4s, then the 8s cap, and a final pause clamped to what is left of the
# 120s window. Eighteen pauses consume the window exactly, so the nineteenth
# verification is the one that reports the deadline.
persistent_sleeps="1 2 4 $(repeat_token 8 14) 1"
# With a frozen clock the deadline can never be reached, so the attempt backstop
# is the only bound: 200 verifications and 199 pauses.
frozen_sleeps="1 2 4 $(repeat_token 8 196)"

# A single readiness failure is absorbed.
run_case transient transient-until 0 2 '1'
assert_contains "$work_dir/transient/stderr" 'retrying in 1s'
assert_contains "$work_dir/transient/stdout" 'verified'
assert_diagnostics transient 1

# The retired three-attempt model would have failed here; the deadline model
# keeps retrying while the window has time left.
case_env=(FAKE_TRANSIENT_FAILURES=5)
run_case transient-five transient-until 0 6 '1 2 4 8 8'
assert_contains "$work_dir/transient-five/stdout" 'verified'
assert_diagnostics transient-five 1

# A permanently unavailable image stops at the wall-clock deadline, with an
# exact, deterministic, capped and clamped backoff schedule.
run_case deadline persistent-transient 1 19 "$persistent_sleeps"
assert_contains "$work_dir/deadline/stderr" 'remained temporarily unavailable for 120s across 19 attempts'
# Diagnostics are one-shot even across eighteen retries.
assert_diagnostics deadline 1

# A permanent failure keeps hdiutil's own output and never retries.
run_case permanent permanent 1 1 ''
assert_contains "$work_dir/permanent/stderr" 'invalid checksum'
assert_absent "$work_dir/permanent/stderr" 'retrying in'
assert_diagnostics permanent 0

# The original, non-1 hdiutil status survives a permanent failure...
case_env=(FAKE_VERIFY_STATUS=5)
run_case permanent-status permanent 5 1 ''
assert_contains "$work_dir/permanent-status/stderr" 'invalid checksum'

# ...and an exhausted readiness window.
case_env=(FAKE_VERIFY_STATUS=5 RELAYIUM_HDIUTIL_VERIFY_DEADLINE_SECONDS=3)
run_case transient-status persistent-transient 5 3 '1 2'
assert_contains "$work_dir/transient-status/stderr" 'remained temporarily unavailable for 3s across 3 attempts'

# An errno detail appended to hdiutil's own reason is still the readiness race.
run_case transient-detail transient-detail 0 2 '1'
assert_contains "$work_dir/transient-detail/stderr" 'retrying in 1s'
assert_contains "$work_dir/transient-detail/stdout" 'verified'
assert_diagnostics transient-detail 1

# The phrase as the leading segment of a path is not a token-boundary match.
run_case phrase-path-suffix phrase-path-suffix 1 1 ''
assert_contains "$work_dir/phrase-path-suffix/stderr" 'unavailable/Relayium.dmg'
assert_absent "$work_dir/phrase-path-suffix/stderr" 'retrying in'
assert_diagnostics phrase-path-suffix 0

# The phrase inside a path is not a readiness signal.
run_case path-lookalike path-lookalike 1 1 ''
assert_contains "$work_dir/path-lookalike/stderr" 'No such file or directory'
assert_absent "$work_dir/path-lookalike/stderr" 'retrying in'
assert_diagnostics path-lookalike 0

# Neither is the phrase without hdiutil's own failed-operation prefix.
run_case unprefixed unprefixed-phrase 1 1 ''
assert_contains "$work_dir/unprefixed/stderr" 'checksum mismatch'
assert_absent "$work_dir/unprefixed/stderr" 'retrying in'
assert_diagnostics unprefixed 0

# A clock that never advances cannot defeat the bound.
case_env=(FAKE_CLOCK_ADVANCES=0)
run_case frozen-clock persistent-transient 1 200 "$frozen_sleeps"
assert_contains "$work_dir/frozen-clock/stderr" 'remained temporarily unavailable after 200 attempts'
assert_diagnostics frozen-clock 1

# A zero deadline means one verification and no retry.
case_env=(RELAYIUM_HDIUTIL_VERIFY_DEADLINE_SECONDS=0)
run_case deadline-zero persistent-transient 1 1 ''
assert_contains "$work_dir/deadline-zero/stderr" 'remained temporarily unavailable for 0s across 1 attempts'
assert_absent "$work_dir/deadline-zero/stderr" 'retrying in'

# A zero initial backoff normalizes to 1s and lifts a smaller cap with it.
case_env=(
  RELAYIUM_HDIUTIL_VERIFY_DEADLINE_SECONDS=3
  RELAYIUM_HDIUTIL_VERIFY_INITIAL_BACKOFF_SECONDS=0
  RELAYIUM_HDIUTIL_VERIFY_MAX_BACKOFF_SECONDS=0
)
run_case normalized-backoff persistent-transient 1 4 '1 1 1'

# Zero-padded values are decimal, not octal.
case_env=(
  RELAYIUM_HDIUTIL_VERIFY_DEADLINE_SECONDS=0003
  RELAYIUM_HDIUTIL_VERIFY_INITIAL_BACKOFF_SECONDS=01
  RELAYIUM_HDIUTIL_VERIFY_MAX_BACKOFF_SECONDS=08
)
run_case leading-zeros persistent-transient 1 3 '1 2'

# Every configuration value is validated before the first verification, so a
# misconfigured window fails loudly instead of silently disabling the retry.
case_env=(RELAYIUM_HDIUTIL_VERIFY_DEADLINE_SECONDS=abc)
run_case config-deadline persistent-transient 78 0 ''
assert_contains "$work_dir/config-deadline/stderr" 'RELAYIUM_HDIUTIL_VERIFY_DEADLINE_SECONDS must be a non-negative integer'
assert_diagnostics config-deadline 0

case_env=(RELAYIUM_HDIUTIL_VERIFY_INITIAL_BACKOFF_SECONDS=-1)
run_case config-initial persistent-transient 78 0 ''
assert_contains "$work_dir/config-initial/stderr" 'RELAYIUM_HDIUTIL_VERIFY_INITIAL_BACKOFF_SECONDS must be a non-negative integer'

case_env=(RELAYIUM_HDIUTIL_VERIFY_MAX_BACKOFF_SECONDS=8s)
run_case config-max-backoff persistent-transient 78 0 ''
assert_contains "$work_dir/config-max-backoff/stderr" 'RELAYIUM_HDIUTIL_VERIFY_MAX_BACKOFF_SECONDS must be a non-negative integer'

case_env=(RELAYIUM_HDIUTIL_VERIFY_MAX_ATTEMPTS='')
run_case config-max-attempts persistent-transient 78 0 ''
assert_contains "$work_dir/config-max-attempts/stderr" 'RELAYIUM_HDIUTIL_VERIFY_MAX_ATTEMPTS must be a non-negative integer'

# Several bad values are all reported from the same pre-flight check.
case_env=(
  RELAYIUM_HDIUTIL_VERIFY_DEADLINE_SECONDS=x
  RELAYIUM_HDIUTIL_VERIFY_MAX_ATTEMPTS=y
)
run_case config-multiple persistent-transient 78 0 ''
assert_contains "$work_dir/config-multiple/stderr" 'RELAYIUM_HDIUTIL_VERIFY_DEADLINE_SECONDS must be a non-negative integer'
assert_contains "$work_dir/config-multiple/stderr" 'RELAYIUM_HDIUTIL_VERIFY_MAX_ATTEMPTS must be a non-negative integer'

# The guarded verification call sites must stay where the packaging and
# notarization flows need them. The needles are deliberately literal source
# text, so shellcheck's expansion advice does not apply here.
# shellcheck disable=SC2016
if [ "$(grep -Fc 'verify_hdiutil_image "$dmg_work"' "$script_dir/package-dmg.sh")" -ne 1 ]; then
  fail 'package-dmg.sh does not call verify_hdiutil_image exactly once'
fi
# shellcheck disable=SC2016
if [ "$(grep -Fc 'verify_hdiutil_image "$dmg"' "$script_dir/notarize-dmg.sh")" -ne 2 ]; then
  fail 'notarize-dmg.sh does not call verify_hdiutil_image exactly twice'
fi

if [ "$failures" -ne 0 ]; then
  echo "package-dmg tests failed: $failures assertion(s)" >&2
  exit 1
fi

echo 'package-dmg tests passed'
