#!/usr/bin/env bash
#
# **Cloud (stored) transfers, on a real emulator, against a real server.**
#
#   ./scripts/android-cloud-acceptance.sh
#
# This is the Slice B evidence that stored transfers work as a PRODUCT and not
# only as unit tests. It drives the real `MainActivity` through
# `CloudAcceptanceTest`:
#
#   * the account gate — uploading needs one because the bytes are stored and
#     metered against it, and opening a link never does;
#   * a mixed selection (a zero-byte file, one larger than a 192 KiB chunk, and
#     a small one) uploaded encrypted, then opened from its own link and saved
#     into a granted tree, compared by SHA-256 at both ends;
#   * burn-after-read: saved once, and the second open of the same link
#     correctly reports the object is gone;
#   * a hostile manifest — a traversing name, and two entries that would land on
#     one document — refused BEFORE a folder is asked for, with nothing created
#     in the user's tree;
#   * a finished upload surviving an Activity recreation;
#   * the cloud surface's OWN launchers driven through the real DocumentsUI —
#     file picker, Activity recreation, folder picker, system-granted tree —
#     because `android-ui-session-acceptance.sh` proves that round trip for the
#     SESSION launchers and says nothing about these. The recreation there is
#     BETWEEN the two pickers: a result arriving into an Activity recreated
#     while its picker was still open is NOT covered and is not claimed.
#
# It runs the class under BOTH maintained languages, because every assertion
# resolves its expected text through the app's own resources.
#
# ## Why each language gets its own backend
#
# The same reason `android-account-acceptance.sh` does: `/api/auth/register` and
# `/api/cli/device/start` share one per-IP limiter (5/minute, `registerLimiter`
# in main.go) and every request here arrives from one address. A single-server
# run spends that budget across two languages and the second one is correctly
# denied — a language-dependent failure that looks like a product bug and is
# not. Isolation is the fix; a weaker limiter would be testing a server nobody
# ships.
#
# ## What is real here
#
# The bytes, the encryption, the upload, the anonymous ciphertext download, the
# manifest refusals and the documents written into a granted tree are all real,
# and they cross the `content://` boundary through `ContentResolver` and
# `DocumentsContract`. The byte-level cases supply the picker RESULT directly,
# which keeps them deterministic; the system picker's own UI is driven once, by
# the case that exists to cover the cloud launchers themselves.
#
# Outgoing fixtures and saved documents live in DIFFERENT trees. Sharing one
# would put a same-named document in the destination before the save, and the
# receive store refuses to overwrite — correctly.
#
# ## Credentials
#
# The fixture account is generated per run against a throwaway database. Its
# password reaches the device as an instrumentation argument and the server in a
# 0600 file, and neither is ever echoed: `set -x` is never enabled and no `say`
# line prints one. No link is printed either — a stored link carries its
# decryption key in its fragment.
set -Eeuo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$here/.." && pwd)"
# shellcheck source-path=SCRIPTDIR
# shellcheck source=lib/local-acceptance.sh
. "$here/lib/local-acceptance.sh"

adb="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-}}/platform-tools/adb"
serial="${ANDROID_SERIAL:-}"
gradle_bin="${RELAYIUM_GRADLE:-$repo/apps/android/gradlew}"
app_id="com.relayium.android.debug"
test_pkg="$app_id.test"
runner="androidx.test.runner.AndroidJUnitRunner"
test_class="com.relayium.android.CloudAcceptanceTest"
out_dir="${RELAYIUM_CLOUD_OUT:-$repo/apps/android/build/cloud-acceptance}"

# The class's @Test methods. The run must EXECUTE all of them — reaching
# INSTRUMENTATION_CODE -1 is also what a zero-test run does. Bump when a test is
# added.
expected_tests=6

require_emulator() {
  [ -x "$adb" ] || fail "adb not found at $adb; set ANDROID_HOME or ANDROID_SDK_ROOT"
  local devices
  devices="$("$adb" devices | awk 'NR>1 && $2=="device" {print $1}')"
  [ -n "$devices" ] || fail "no attached device; start an emulator first (this run does not create one)"
  [ -n "$serial" ] || serial="$(printf '%s\n' "$devices" | head -1)"
  printf '%s\n' "$devices" | grep -qx "$serial" \
    || fail "ANDROID_SERIAL=$serial is not among the attached devices: $devices"
  say "-- driving $serial"
}

adbs() { "$adb" -s "$serial" "$@"; }

if [ -z "${RELAYIUM_CLOUD_LOCALE:-}" ]; then
  say "== running one isolated child per maintained language =="
  child_failures=0
  for child_locale in en-US zh-CN; do
    say ""
    say "== $child_locale (its own backend, database and fixture account) =="
    if RELAYIUM_CLOUD_LOCALE="$child_locale" "$0"; then
      say "-- $child_locale passed"
    else
      say "-- FAILED under $child_locale"
      child_failures=$((child_failures + 1))
    fi
  done
  if [ "$child_failures" -ne 0 ]; then
    say "ERROR: $child_failures language(s) failed"
    exit 1
  fi
  say ""
  say "== the cloud acceptance passed under both maintained languages =="
  say "   instrumentation logs and reports under $out_dir"
  exit 0
fi

# ── from here down: ONE language, one disposable backend ────────────────────
locale="$RELAYIUM_CLOUD_LOCALE"
case "$locale" in
  en-US) name=en ;;
  zh-CN) name=zh ;;
  *) say "ERROR: unsupported RELAYIUM_CLOUD_LOCALE $locale"; exit 1 ;;
esac

acceptance_begin
mkdir -p "$out_dir"

say "== building the local server =="
( cd "$repo/server" && go build -o "$run_root/relayium-server" . ) \
  || fail "the local server failed to build"

say "== building the debug APK and its instrumentation =="
[ -x "$gradle_bin" ] || gradle_bin="gradle"
( cd "$repo/apps/android" && "$gradle_bin" -Prelayium.android=true \
    :app:assembleDebug :app:assembleDebugAndroidTest >"$run_root/gradle.log" 2>&1 ) \
  || fail "the Android build failed: $(tail -30 "$run_root/gradle.log")"
app_apk="$repo/apps/android/app/build/outputs/apk/debug/app-debug.apk"
test_apk="$repo/apps/android/app/build/outputs/apk/androidTest/debug/app-debug-androidTest.apk"
[ -f "$app_apk" ] || fail "no debug APK at $app_apk"
[ -f "$test_apk" ] || fail "no instrumentation APK at $test_apk"

require_emulator

server_port="$(free_port)"
origin="http://127.0.0.1:$server_port"
emulator_origin="http://10.0.2.2:$server_port"
mkdir -p "$run_root/blobs" "$run_root/no-static"

# The base URL is the one the DEVICE resolves, so the app's own origin check —
# which is what refuses a link naming a foreign host — is exercised unchanged.
say "== starting a throwaway server on $origin (base URL $emulator_origin) =="
RELAYIUM_RELEASE_CHECK=false \
RELAYIUM_BASE_URL="$emulator_origin" \
  "$run_root/relayium-server" \
  -addr "127.0.0.1:$server_port" \
  -db "$run_root/relayium.db" \
  -blob-dir "$run_root/blobs" \
  -static "$run_root/no-static" \
  -stun-urls "$loopback_stun" \
  -mail-transport dev-log-links \
  >"$run_root/server.log" 2>&1 &
server_pid=$!
register_child server "$server_pid"

for _ in $(seq 1 100); do
  curl -sf --max-time 5 "$origin/api/config" >/dev/null 2>&1 && break
  kill -0 "$server_pid" 2>/dev/null || fail "the server exited: $(tail -5 "$run_root/server.log")"
  sleep 0.2
done
curl -sf --max-time 5 "$origin/api/config" >/dev/null 2>&1 \
  || fail "the server never became reachable"
assert_run_was_local

# The password has to reach the DEVICE as an instrumentation argument, so this
# run opts in to keeping it in the shell. It is never printed.
acceptance_publish_password=1
acceptance_create_account

say "== installing =="
adbs install -r -t "$app_apk" >/dev/null || fail "could not install the app"
adbs install -r -t "$test_apk" >/dev/null || fail "could not install the instrumentation"

orig_locales="$(adbs shell cmd locale get-app-locales "$app_id" 2>/dev/null | tr -d '\r' \
  | sed -n 's/.*\[\([^]]*\)\].*/\1/p')"
orig_backend="$(adbs shell getprop debug.relayium.backend | tr -d '\r')"

set_app_locale() {
  local tag="$1"
  if [ -n "$tag" ]; then
    adbs shell cmd locale set-app-locales "$app_id" --user 0 --locales "$tag"
  else
    adbs shell cmd locale set-app-locales "$app_id" --user 0
  fi
}

restore_device() {
  set_app_locale "$orig_locales" >/dev/null 2>&1 || true
  if [ -n "$orig_backend" ]; then
    adbs shell setprop debug.relayium.backend "$orig_backend" >/dev/null 2>&1 || true
  else
    adbs shell setprop debug.relayium.backend '""' >/dev/null 2>&1 || true
  fi
  adbs shell am force-stop "$app_id" >/dev/null 2>&1 || true
}
acceptance_extra_cleanup() { restore_device; }

adbs shell setprop debug.relayium.backend "$emulator_origin" \
  || fail "could not point the app at $emulator_origin"
[ "$(adbs shell getprop debug.relayium.backend | tr -d '\r')" = "$emulator_origin" ] \
  || fail "the backend property did not take"

say ""
say "== $test_class under $locale =="
# A fresh app state: a keystore-wrapped bearer from an earlier run would restore
# a session the account-gate test does not expect, and a leftover test tree
# would make a "saved" assertion pass on somebody else's bytes.
adbs shell pm clear "$app_id" >/dev/null 2>&1 || true
adbs shell setprop debug.relayium.backend "$emulator_origin" >/dev/null
set_app_locale "$locale" >/dev/null

log="$out_dir/instrument-$name.log"
set +e
adbs shell am instrument -w -r \
  -e class "$test_class" \
  -e relayium.origin "$emulator_origin" \
  -e relayium.email "$account_email" \
  -e relayium.password "$account_password" \
  "$test_pkg/$runner" >"$log" 2>&1
status=$?
set -e

# FOUR conditions, because "-1 alone" is a run that reached the end — which a
# ZERO-test run also does. The count is what proves the tests actually ran.
ran="$(grep -oE 'OK \([0-9]+ test' "$log" | grep -oE '[0-9]+' | tail -1 || true)"
if [ "$status" -ne 0 ] \
   || ! grep -q '^INSTRUMENTATION_CODE: -1$' "$log" \
   || grep -qE '^INSTRUMENTATION_STATUS_CODE: (-1|-2)$' "$log" \
   || grep -q 'FAILURES!!!' "$log" \
   || [ "${ran:-0}" -lt "$expected_tests" ]; then
  say "-- FAILED under $locale (adb exit $status, ran=${ran:-0}/$expected_tests):"
  sed -n '/INSTRUMENTATION_STATUS: stack=/,/^INSTRUMENTATION_STATUS_CODE/p' "$log" | head -40 >&2
  restore_device
  fail "$test_class failed under $locale"
fi
say "-- passed under $locale ($ran tests)"

# ── the app's own observations ──────────────────────────────────────────────
#
# `InteropDriver.report` writes `files/<name>` — with NO extension — so the read
# below must name that exact path. Reading `files/<name>.json` would fetch
# nothing, and `adb exec-out` carries the REMOTE `cat`'s diagnostic back on
# STDOUT, so the harness would cheerfully save "No such file or directory" into
# a file called a report and, with `|| true`, call the run a pass. That exact
# pattern already cost a Slice A round; it is fail-CLOSED here instead: each
# report must exist and must parse as JSON.
for report in cloud-account-gate cloud-round-trip cloud-burn cloud-hostile-manifest \
              cloud-recreation cloud-system-picker; do
  dest="$out_dir/$report-$name.json"
  adbs exec-out run-as "$app_id" cat "files/$report" >"$dest" 2>/dev/null \
    || fail "could not read the $report report off the device"
  [ -s "$dest" ] || fail "the $report report is empty; the test did not write it"
  python3 -c 'import json,sys; json.load(open(sys.argv[1]))' "$dest" \
    || fail "the $report report is not JSON — it is almost certainly a device-side \
diagnostic that adb carried back on stdout"
done

# A report is a durable copy, and a stored link carries its decryption key.
if grep -rl '#k=' "$out_dir" 2>/dev/null | grep -q .; then
  fail "a report contains a link fragment; a stored link carries its decryption key"
fi

restore_device
say "-- $locale done; its server, database and fixture account go with this run"

# The LAST line, and nowhere else. `cleanup` in the shared library treats a zero
# exit WITHOUT this marker as a failure, precisely so a run that fell out of the
# middle of the script cannot be mistaken for a pass.
completed=1
