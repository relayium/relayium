#!/usr/bin/env bash
#
# **The join form and the launch-intent lifecycle, on a real emulator, across
# the configuration corners that break layouts.**
#
#   ./scripts/android-ui-acceptance.sh
#
# This is the OFFLINE half of the Android UI evidence: `UiAcceptanceTest` needs
# no server and no peer. It drives the real `MainActivity`/Compose join form and
# asserts that
#
#   * an invalid (five-digit) code and an empty submit each reveal their error
#     VISIBLY after Done/Connect — the R16 finding, where the error rendered
#     below the keyboard at a large font read as a dead key;
#   * a launch/link is consumed exactly once and a recreation does not re-join.
#
# It runs the SAME class under two configuration corners — English / light /
# default density / font 1, and Simplified Chinese / dark / 320 dp / font 2 —
# and captures a fully-drawn screenshot of the join form in each, so a layout
# that only breaks at a large font in one language is caught here rather than by
# a person.
#
# ## The mandatory local-backend precheck
#
# `UiAcceptanceTest` asserts the app resolved THIS run's backend origin before
# it delivers any link. That assertion is only meaningful because this script
# sets the debug backend property to a disposable loopback origin FIRST: a
# reflective override that fell back to production would fail the assertion here
# rather than send a stray join to the real service. Nothing here reaches the
# network — the origin points at a dead loopback port on purpose; the join form
# tests never submit a valid code, and the one link test drives a disposable
# code against an origin nothing is listening on.
set -Eeuo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$here/.." && pwd)"

adb="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-}}/platform-tools/adb"
serial="${ANDROID_SERIAL:-}"
gradle_bin="${RELAYIUM_GRADLE:-$repo/apps/android/gradlew}"
app_id="com.relayium.android.debug"
test_pkg="$app_id.test"
runner="androidx.test.runner.AndroidJUnitRunner"
# A dead loopback port: the app must RESOLVE it (the preflight), never reach it.
origin="http://10.0.2.2:1"
out_dir="${RELAYIUM_UI_OUT:-$repo/apps/android/build/ui-acceptance}"

say() { printf '%s\n' "$*" >&2; }
fail() { say "ERROR: $*"; exit 1; }

[ -x "$adb" ] || fail "adb not found at $adb; set ANDROID_HOME or ANDROID_SDK_ROOT"
devices="$("$adb" devices | awk 'NR>1 && $2=="device" {print $1}')"
[ -n "$devices" ] || fail "no attached device; start an emulator first"
[ -n "$serial" ] || serial="$(printf '%s\n' "$devices" | head -1)"
printf '%s\n' "$devices" | grep -qx "$serial" || fail "ANDROID_SERIAL=$serial not attached ($devices)"
adbs() { "$adb" -s "$serial" "$@"; }

say "== building the debug APK and its instrumentation =="
[ -x "$gradle_bin" ] || gradle_bin="gradle"
( cd "$repo/apps/android" && "$gradle_bin" -Prelayium.android=true \
    :app:assembleDebug :app:assembleDebugAndroidTest >/dev/null ) \
  || fail "the Android build failed"
app_apk="$repo/apps/android/app/build/outputs/apk/debug/app-debug.apk"
test_apk="$repo/apps/android/app/build/outputs/apk/androidTest/debug/app-debug-androidTest.apk"
adbs install -r -t "$app_apk" >/dev/null || fail "could not install the app"
adbs install -r -t "$test_apk" >/dev/null || fail "could not install the instrumentation"

mkdir -p "$out_dir"

# ── snapshot the ACTUAL active configuration BEFORE any mutation ─────────────
# The snapshot and the EXIT trap come first, before this run touches the
# backend prop or any config, so restore returns EXACTLY what was here — not
# the disposable values this run is about to set.
#
# `wm density` prints "Physical density: N" and, only when one is set, an
# "Override density: M". The OVERRIDE is what a change replaces, so restore
# means re-applying the override if there was one, or `reset` if there was not.
density_dump="$(adbs shell wm density | tr -d '\r')"
orig_density_override="$(printf '%s\n' "$density_dump" | sed -n 's/^Override density: //p')"
orig_font="$(adbs shell settings get system font_scale | tr -d '\r')"
[ "$orig_font" = "null" ] && orig_font="1.0"
# The app-scoped locale override, read from the bracketed payload of
# `get-app-locales` ("… are [zh-CN]" or "… are []"). Empty means "follow the
# system". Read-only.
orig_locales="$(adbs shell cmd locale get-app-locales "$app_id" 2>/dev/null | tr -d '\r' \
  | sed -n 's/.*\[\([^]]*\)\].*/\1/p')"
# The active night mode ("Night mode: yes|no|auto"), restored as it was.
orig_night="$(adbs shell cmd uimode night 2>/dev/null | tr -d '\r' | sed -n 's/.*: //p')"
case "$orig_night" in yes|no|auto) : ;; *) orig_night="no" ;; esac
# The debug backend override, snapshotted BEFORE this run sets it (usually empty).
orig_backend="$(adbs shell getprop debug.relayium.backend | tr -d '\r')"

# 320 dp smallest-width needs a density derived from THIS device's pixel width,
# not a constant that is only right at 1080 px: dpi = shortest_px * 160 / 320.
short_px="$(adbs shell wm size | tr -d '\r' | sed -n 's/^Physical size: //p' | head -1 \
  | awk -Fx '{print ($1<$2)?$1:$2}')"
[ -n "$short_px" ] || short_px=1080
dp320_density=$(( short_px * 160 / 320 ))

# Set the app-scoped locale, or CLEAR it when the tag is empty. An empty
# `--locales ""` argument does not survive `adb shell`'s argv concatenation, so
# clearing omits the flag entirely (the form that actually resets the override).
set_app_locale() {
  local tag="$1"
  if [ -n "$tag" ]; then
    adbs shell cmd locale set-app-locales "$app_id" --user 0 --locales "$tag"
  else
    adbs shell cmd locale set-app-locales "$app_id" --user 0
  fi
}

restore() {
  say "-- restoring the device's active configuration"
  adbs shell cmd uimode night "$orig_night" >/dev/null 2>&1 || true
  if [ -n "$orig_density_override" ]; then
    adbs shell wm density "$orig_density_override" >/dev/null 2>&1 || true
  else
    adbs shell wm density reset >/dev/null 2>&1 || true
  fi
  adbs shell settings put system font_scale "$orig_font" >/dev/null 2>&1 || true
  set_app_locale "$orig_locales" >/dev/null 2>&1 || true
  if [ -n "$orig_backend" ]; then
    adbs shell setprop debug.relayium.backend "$orig_backend" >/dev/null 2>&1 || true
  else
    adbs shell setprop debug.relayium.backend '""' >/dev/null 2>&1 || true
  fi
  adbs shell am force-stop "$app_id" >/dev/null 2>&1 || true
}
trap restore EXIT

# Only NOW, with the snapshot taken and the restore trap armed, point the app
# at this run's disposable origin — so a crash from here on still restores it.
adbs shell setprop debug.relayium.backend "$origin" || fail "could not set the backend prop"
[ "$(adbs shell getprop debug.relayium.backend | tr -d '\r')" = "$origin" ] \
  || fail "the backend property did not take"

# name  locale  night  density  font. The default corner resets density (empty
# density field → `wm density reset`); the stress corner is 320 dp at this
# device's real width, dark, font 2.0, Simplified Chinese.
configs=(
  "en-light-default-font1 en-US no reset 1.0"
  "zh-dark-320dp-font2 zh-CN yes $dp320_density 2.0"
)

# The class has exactly these three @Test methods; the run must EXECUTE all of
# them, not merely reach INSTRUMENTATION_CODE -1 (which a zero-test run also
# reports). Bump this if a test is added.
expected_tests=3

failures=0
for cfg in "${configs[@]}"; do
  read -r name locale night density font <<<"$cfg"
  say ""
  say "== config $name (locale=$locale night=$night density=$density font=$font) =="
  set_app_locale "$locale" >/dev/null
  adbs shell cmd uimode night "$night" >/dev/null
  if [ "$density" = "reset" ]; then
    adbs shell wm density reset >/dev/null
  else
    adbs shell wm density "$density" >/dev/null
  fi
  adbs shell settings put system font_scale "$font" >/dev/null

  # The instrumentation is the pass/fail. Both form tests plus the lifecycle
  # test run here.
  log="$out_dir/instrument-$name.log"
  set +e
  adbs shell am instrument -w -r \
    -e class com.relayium.android.UiAcceptanceTest \
    -e relayium.origin "$origin" \
    "$test_pkg/$runner" >"$log" 2>&1
  status=$?
  set -e
  # FOUR conditions, because "-1 alone" is a run that reached the end — which a
  # ZERO-test run also does. The count is what proves the tests actually ran.
  #
  # `|| true` is load-bearing: on a FAILED run the log has no "OK (N tests)"
  # line, so the grep pipeline exits non-zero, and under `set -e`/pipefail a
  # bare `ran="$(…)"` would abort the whole script HERE — before the diagnostic
  # block below ever runs — turning an informative failure into a silent
  # EXIT 1. Swallowing only this extraction's status keeps the failure visible.
  ran="$(grep -oE 'OK \([0-9]+ test' "$log" | grep -oE '[0-9]+' | tail -1 || true)"
  if [ "$status" -ne 0 ] \
     || ! grep -q '^INSTRUMENTATION_CODE: -1$' "$log" \
     || grep -qE '^INSTRUMENTATION_STATUS_CODE: (-1|-2)$' "$log" \
     || grep -q 'FAILURES!!!' "$log" \
     || [ "${ran:-0}" -lt "$expected_tests" ]; then
    say "-- FAILED under $name (adb exit $status, ran=${ran:-0}/$expected_tests):"
    sed -n '/INSTRUMENTATION_STATUS: stack=/,/^INSTRUMENTATION_STATUS_CODE/p' "$log" | head -30 >&2
    # Pull any failure screenshot the test captured into the app's OWN internal
    # files dir (this app has no storage permission, so it writes there, not to
    # shared storage), read back with run-as.
    adbs exec-out run-as "$app_id" cat "files/ui-acceptance-error-not-displayed.png" \
      >"$out_dir/$name-failure.png" 2>/dev/null || true
    [ -s "$out_dir/$name-failure.png" ] \
      && say "-- failure screenshot: $out_dir/$name-failure.png" \
      || rm -f "$out_dir/$name-failure.png"
    failures=$((failures + 1))
    continue
  fi
  say "-- instrumentation passed under $name ($ran tests)"

  # A fully-drawn screenshot of the join form: cold-start the app, wait for it
  # to settle, capture, then stop it. (am start -W returns before the first
  # frame is fully composed at a large font, so give it a moment.)
  adbs shell am start -W -n "$app_id/com.relayium.android.MainActivity" >/dev/null 2>&1 || true
  sleep 4
  adbs exec-out screencap -p >"$out_dir/$name.png" 2>/dev/null \
    && say "-- screenshot: $out_dir/$name.png" || say "-- (screenshot capture failed under $name)"
  adbs shell am force-stop "$app_id" >/dev/null 2>&1 || true
done

[ "$failures" -eq 0 ] || fail "$failures configuration(s) failed"

# Restore now (the EXIT trap also would) and VERIFY it took, so the claim that
# the device was returned to its snapshot is checked, not merely attempted.
restore
now_density_override="$(adbs shell wm density | tr -d '\r' | sed -n 's/^Override density: //p')"
now_font="$(adbs shell settings get system font_scale | tr -d '\r')"
[ "$now_font" = "null" ] && now_font="1.0"
now_backend="$(adbs shell getprop debug.relayium.backend | tr -d '\r')"
[ "$now_density_override" = "$orig_density_override" ] \
  || say "-- WARNING: density override is '$now_density_override', expected '$orig_density_override'"
[ "$now_font" = "$orig_font" ] \
  || say "-- WARNING: font scale is '$now_font', expected '$orig_font'"
[ "$now_backend" = "$orig_backend" ] \
  || say "-- WARNING: backend prop is '$now_backend', expected '$orig_backend'"

say ""
say "== UI acceptance passed under all ${#configs[@]} configuration corners =="
say "   screenshots and instrumentation logs under $out_dir"
