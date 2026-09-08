#!/usr/bin/env bash
#
# **The account and create surfaces, on a real emulator, against a real server.**
#
#   ./scripts/android-account-acceptance.sh
#
# This is the Slice A evidence that the account layer works as a PRODUCT and not
# only as a set of unit tests. It drives the real `MainActivity` through
# `AccountAcceptanceTest`:
#
#   * native email/password sign-in, and the server's own account facts —
#     identity, plan, quota, device list — rendered from real API responses;
#   * a refused sign-in and a refused registration each returning to a form that
#     still has what the user typed (the R8/R9 regressions, observed on a device);
#   * browser-approved sign-in through the REAL `/api/cli/device/{start,poll}`
#     pair, which is the only route in for an account that has no password —
#     this build ships no Google SDK and no Play Services;
#   * a real `POST /api/pair` mint, and the room those six digits name actually
#     being joined through the same controller a pasted code goes through;
#   * sign-out reaching the state that is only reachable when the SERVER
#     answered the revocation.
#
# It runs the class under BOTH maintained languages, because every assertion
# resolves its expected text through the app's own resources.
#
# ## Why this starts its own server rather than reusing acceptance_start_server
#
# `/api/cli/device/start` answers `verification_uri = <BaseURL>/device` — the
# server's CONFIGURED base URL, not the request's origin (deviceauth.go). The
# shared helper starts the server without `-base-url`, so it would advertise
# `http://localhost:8080`, and the app would correctly REFUSE that page: it is
# not on the origin this device resolved. That refusal is the product working.
# So the harness sets `RELAYIUM_BASE_URL` to the exact origin the emulator
# reaches (`http://10.0.2.2:<port>`) before starting the server. The app's trust
# check is untouched — nothing here widens a host allowlist to make a test pass.
#
# ## Credentials
#
# The fixture account is generated per run against a throwaway database. Its
# password reaches the device as an instrumentation argument and reaches the
# server in a 0600 file, and neither is ever echoed: `set -x` is never enabled,
# and no `say` line prints one.
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
test_class="com.relayium.android.AccountAcceptanceTest"
out_dir="${RELAYIUM_ACCOUNT_OUT:-$repo/apps/android/build/account-acceptance}"

# The class's @Test methods. The run must EXECUTE all of them — reaching
# INSTRUMENTATION_CODE -1 is also what a zero-test run does. Bump when a test is
# added.
expected_tests=7

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

# ── one isolated child per language ─────────────────────────────────────────
#
# Each language gets its OWN server process, database and fixture account, and
# that is a correctness requirement rather than tidiness.
#
# `/api/auth/register` and `/api/cli/device/start` share ONE per-IP limiter —
# 5/minute (`registerLimiter`, main.go) — and every request in this harness
# arrives from the same address. A single-server run therefore spends: the
# fixture registration (1), the EN duplicate-registration test (2), the EN
# registration-success test (3), the EN browser device-start (4), the zh
# duplicate (5), and then the zh registration-success is the sixth and is
# correctly DENIED. The symptom is a language-dependent timeout that looks like
# a product bug and is not one; it only hid before because a slower failing run
# let the window refill.
#
# The fix is isolation, never a weaker limiter, a skipped test or a blind retry:
# the limiter is real protection against an email bomb and a Sybil mint, and a
# harness that needed it turned down would be testing a server nobody ships. A
# fresh server process starts with a fresh window, so each child gets its own
# budget and the product's own rule is exercised unchanged.
if [ -z "${RELAYIUM_ACCOUNT_LOCALE:-}" ]; then
  say "== running one isolated child per maintained language =="
  child_failures=0
  for child_locale in en-US zh-CN; do
    say ""
    say "== $child_locale (its own backend, database and fixture account) =="
    if RELAYIUM_ACCOUNT_LOCALE="$child_locale" "$0"; then
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
  say "== the account acceptance passed under both maintained languages =="
  say "   instrumentation logs and reports under $out_dir"
  exit 0
fi

# ── from here down: ONE language, one disposable backend ────────────────────
locale="$RELAYIUM_ACCOUNT_LOCALE"
case "$locale" in
  en-US) name=en ;;
  zh-CN) name=zh ;;
  *) say "ERROR: unsupported RELAYIUM_ACCOUNT_LOCALE $locale"; exit 1 ;;
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

# ── the server, with the base URL the DEVICE will resolve ────────────────────
server_port="$(free_port)"
origin="http://127.0.0.1:$server_port"
emulator_origin="http://10.0.2.2:$server_port"
mkdir -p "$run_root/blobs" "$run_root/no-static"

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
# A second, never-registered address, for the registration-refusal and
# registration-success paths. Unique per RUN, and each language is its own run
# against its own database.
fresh_email="fresh-${run_tag}@example.invalid"

# A cookie session for the same account, so the shell can approve the device
# code the way the signed-in website does. `/api/cli/device/approve` is
# session-authed on purpose: a leaked bearer must not be able to approve a new
# one for itself.
umask 077
printf '{"email":"%s","password":"%s"}' "$account_email" "$account_password" \
  >"$run_root/cookie-login.json"
curl -sf --max-time 20 -X POST "$origin/api/auth/password/login" \
  -H 'Content-Type: application/json' \
  --data-binary "@$run_root/cookie-login.json" \
  -c "$run_root/cookies.txt" -o /dev/null \
  || fail "could not open a cookie session for the approval half"
rm -f "$run_root/cookie-login.json"

say "== installing =="
adbs install -r -t "$app_apk" >/dev/null || fail "could not install the app"
adbs install -r -t "$test_apk" >/dev/null || fail "could not install the instrumentation"

# ── device configuration, snapshotted BEFORE anything is changed ─────────────
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

# ── the approval half ────────────────────────────────────────────────────────
#
# The browser-approval test writes the user code the app is showing into the
# app's own internal files dir and then WAITS. This watcher reads it back with
# `run-as` and approves it as the account owner — which is exactly what a human
# would do at the verification page, minus the browser. It approves at most
# once, so a stale file from an earlier round cannot authorise a second
# credential.
approve_watcher() {
  local code file="files/account-acceptance-usercode.txt" deadline
  deadline=$(( $(date +%s) + 180 ))
  while [ "$(date +%s)" -lt "$deadline" ]; do
    # The read is accepted only when it IS a user code, never merely because it
    # produced output.
    #
    # `adb exec-out` carries the REMOTE command's diagnostics back on stdout, and
    # `2>/dev/null` here silences the local adb client rather than the `cat` on
    # the device. So before the app has written anything, this read returns a
    # 69-character "No such file or directory" string — and a bare non-empty
    # check treated that as a code, POSTed it, got `invalid_or_expired_code`, and
    # then returned, so the watcher was already gone by the time the browser test
    # wrote the real one.
    #
    # The fix is the SHAPE check below, deliberately rather than a remote
    # redirect: `adb` joins its arguments into one command line for the device's
    # own shell, so quoting written here does not survive to become a redirect
    # there, and a fence that depends on getting that right is a fence that can
    # silently stop fencing. `genUserCode` (deviceauth.go) emits `XXXX-XXXX`, so
    # a diagnostic — which has spaces and lowercase letters — cannot match, and
    # neither can a partially written file caught mid-write.
    #
    # A read that is not a code means "not there YET", which is the normal state
    # for most of this loop: keep waiting rather than returning.
    code="$(adbs exec-out run-as "$app_id" cat "$file" 2>/dev/null | tr -d '\r\n' || true)"
    if ! printf '%s' "$code" | grep -qE '^[A-Z0-9]{4}-[A-Z0-9]{4}$'; then
      sleep 1
      continue
    fi

    printf '{"user_code":"%s"}' "$code" >"$run_root/approve.json"
    # The socket is loopback, but the ORIGIN this request claims must be the
    # one the server considers its own. `CSRFGuard` compares the header
    # against `selfOrigin()`, which is derived from the configured BaseURL —
    # and this run configured that to be the address the DEVICE reaches
    # (`10.0.2.2:<port>`), so `127.0.0.1:<port>` is a foreign origin and is
    # correctly rejected. Sending the right header is the fix; dropping the
    # header, or relaxing the guard, would be turning off the check this
    # endpoint has because a leaked bearer must not be able to approve a new
    # one for itself.
    if curl -sf --max-time 20 -X POST "$origin/api/cli/device/approve" \
         -H 'Content-Type: application/json' -H "Origin: $emulator_origin" \
         -b "$run_root/cookies.txt" \
         --data-binary "@$run_root/approve.json" -o /dev/null; then
      say "-- approved the device code the app displayed"
    else
      # A well-shaped code the server refused is a real failure, not a
      # not-yet: stop waiting and let the test report its own timeout.
      say "-- WARNING: the approval call was refused; the test will report the timeout"
    fi
    # Approve at most once per run, so a stale file cannot authorise a second
    # credential.
    adbs exec-out run-as "$app_id" rm -f "$file" >/dev/null 2>&1 || true
    return 0
  done
  say "-- WARNING: no device code appeared within the watcher's window"
}

say ""
say "== $test_class under $locale =="
# A fresh app state: the keystore-wrapped bearer from an earlier run would
# otherwise restore a session this run's first test does not expect.
adbs shell pm clear "$app_id" >/dev/null 2>&1 || true
adbs shell setprop debug.relayium.backend "$emulator_origin" >/dev/null
set_app_locale "$locale" >/dev/null

approve_watcher &
watcher_pid=$!
register_child "approve-$name" "$watcher_pid"

log="$out_dir/instrument-$name.log"
set +e
adbs shell am instrument -w -r \
  -e class "$test_class" \
  -e relayium.origin "$emulator_origin" \
  -e relayium.email "$account_email" \
  -e relayium.password "$account_password" \
  -e relayium.newEmail "$fresh_email" \
  "$test_pkg/$runner" >"$log" 2>&1
status=$?
set -e
kill "$watcher_pid" >/dev/null 2>&1 || true
wait "$watcher_pid" 2>/dev/null || true

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

# The app's own observations, for the record. It contains no credential: the
# sign-out step reports that a revocation happened, never the bearer it revoked.
adbs exec-out run-as "$app_id" cat "files/account-acceptance.json" \
  >"$out_dir/report-$name.json" 2>/dev/null || true

restore_device
say "-- $locale done; its server, database and fixture account go with this run"

# The LAST line, and nowhere else. `cleanup` in the shared library treats a
# zero exit WITHOUT this marker as a failure, precisely so a run that fell out
# of the middle of the script — a `return` from a helper, an early `exit 0` —
# cannot be mistaken for a pass. See scripts/lib/local-acceptance.sh.
completed=1
