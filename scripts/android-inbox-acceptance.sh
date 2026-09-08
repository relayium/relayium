#!/usr/bin/env bash
#
# **The Device Inbox surface, composed on a real emulator.**
#
#   ./scripts/android-inbox-acceptance.sh
#
# Drives `InboxScreenAcceptanceTest` — the REAL `InboxScreen` composable, hosted
# the way `RelayiumApp` hosts the other three surfaces, driven by its visible
# affordances — under both maintained languages.
#
# ## What this proves, and what it deliberately does not
#
# It proves that every state the Inbox model can publish RENDERS, that each
# control acts, and that the honest-copy rules hold on a device: no background
# delivery is promised, a blocked device keeps its reason, a key repair states
# what it costs before it runs, deleting says it is local, an ambiguous send
# says it cannot tell, and a device that cannot present a message is not offered
# one.
#
# It does NOT prove navigation, SAF round trips, share-target ingress or an
# account switch against a live server: this surface has no host yet, and a
# screenshot of a composable is not evidence about an app. Those belong to the
# integrated harness (`android-ui-session-acceptance.sh` and the final
# integration run) and are not claimed here.
#
# There is no backend and no account, because this class needs neither: the
# state is constructed directly from real wire documents through the shipped
# readers, so the surface is exercised against values a server could actually
# send rather than against a stub of the model. The runtime's own behaviour —
# the receive loop, the send coordinator, the ledger — is covered by the JVM
# suites (`InboxRuntimeTest`, `InboxLifecycleTest`, and the component tests),
# which do run against real stores.
#
# ## The configuration matrix
#
# Six groups, because a surface that only renders at one of them is not usable:
# each maintained language in light at the device's own density, and each again
# at a 320 dp smallest width with font scale 2.0 in BOTH appearances — the
# corner where a fixed-height control, an unwrapped row or an overflowing label
# stops being reachable. Dark at the narrow width is run rather than inferred
# from light. Every control is reached with `performScrollTo`, so that is an
# assertion rather than a screenshot somebody has to compare.
#
# The requested configuration is passed to the instrumentation, which asserts
# what the device is ACTUALLY rendering at before any test body runs: `wm
# density` and `settings put` can each be accepted and not applied, and a matrix
# that only asserted what it asked for would report coverage it did not have.
#
# The device's ACTIVE configuration — night mode, density override, font scale
# and the app-scoped locale — is snapshotted BEFORE anything is mutated and
# restored on every exit path, including a failure.
#
# ## Isolation
#
# One temporary root, removed on the way out; cleanup kills exactly the PIDs
# this run started and restores the device's configuration and app state. No
# secrets are handled, so nothing here is redacted — and nothing is printed that
# could carry one either: only status lines, test counts and failure stacks.
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
test_class="com.relayium.android.InboxScreenAcceptanceTest"
out_dir="${RELAYIUM_INBOX_OUT:-$repo/apps/android/build/inbox-acceptance}"

# The class's @Test methods, EXACTLY. `lib/instrumentation-result.sh` is the
# shared judge: `am instrument` exits 0 when the app crashes, when the
# instrumentation is missing and when it printed nothing at all, so the rule has
# to be positive — this many tests observed to finish OK — and it has to be the
# same rule everywhere. Bump when a test is added.
expected_tests=22
result_check="$here/lib/instrumentation-result.sh"

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

acceptance_begin
mkdir -p "$out_dir"

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

say "== installing =="
adbs install -r -t "$app_apk" >/dev/null || fail "could not install the app"
adbs install -r -t "$test_apk" >/dev/null || fail "could not install the instrumentation"

# ── the ACTIVE configuration, snapshotted before any mutation ───────────────
#
# `wm density` prints "Physical density: N" and, only when one is set, an
# "Override density: M". The OVERRIDE is what a change replaces, so restoring
# means re-applying that override if there was one and `reset` if there was not.
orig_locales="$(adbs shell cmd locale get-app-locales "$app_id" 2>/dev/null | tr -d '\r' \
  | sed -n 's/.*\[\([^]]*\)\].*/\1/p')"
# `settings get` answers the literal "null" when NO override exists. Restoring
# that state means DELETING the setting, not writing 1.0 — a device that had no
# font override would otherwise be left with one this run invented.
orig_font="$(adbs shell settings get system font_scale 2>/dev/null | tr -d '\r')"
orig_density_override="$(adbs shell wm density | tr -d '\r' | sed -n 's/^Override density: //p')"
orig_night="$(adbs shell cmd uimode night 2>/dev/null | tr -d '\r' | sed -n 's/.*: //p')"
case "$orig_night" in yes|no|auto) : ;; *) orig_night="no" ;; esac

# 320 dp smallest width needs a density derived from the device's ACTIVE pixel
# width: dpi = shortest_px * 160 / 320.
#
# `wm size` prints "Physical size: WxH" and, when one is set, an
# "Override size: WxH". The OVERRIDE is what the display is actually running at,
# so a density computed from the physical size would miss 320 dp on any device
# whose size is overridden — including one an earlier run left that way. An
# unreadable answer FAILS: assuming 1080 would silently run the whole narrow
# matrix at the wrong width and report it as covered.
size_dump="$(adbs shell wm size | tr -d '\r')"
active_size="$(printf '%s\n' "$size_dump" | sed -n 's/^Override size: //p' | head -1)"
[ -n "$active_size" ] \
  || active_size="$(printf '%s\n' "$size_dump" | sed -n 's/^Physical size: //p' | head -1)"
short_px="$(printf '%s\n' "$active_size" | awk -Fx 'NF==2 {print ($1<$2)?$1:$2}')"
case "$short_px" in
  '' | *[!0-9]*) fail "could not read the device's active size from: $size_dump" ;;
esac
[ "$short_px" -ge 320 ] || fail "the device's active width is $short_px px; 320 dp is unreachable"
dp320_density=$(( short_px * 160 / 320 ))

set_app_locale() {
  local tag="$1"
  if [ -n "$tag" ]; then
    adbs shell cmd locale set-app-locales "$app_id" --user 0 --locales "$tag"
  else
    adbs shell cmd locale set-app-locales "$app_id" --user 0
  fi
}

restore_device() {
  say "-- restoring the device's active configuration"
  adbs shell cmd uimode night "$orig_night" >/dev/null 2>&1 || true
  if [ -n "$orig_density_override" ]; then
    adbs shell wm density "$orig_density_override" >/dev/null 2>&1 || true
  else
    adbs shell wm density reset >/dev/null 2>&1 || true
  fi
  if [ -n "$orig_font" ] && [ "$orig_font" != "null" ]; then
    adbs shell settings put system font_scale "$orig_font" >/dev/null 2>&1 || true
  else
    adbs shell settings delete system font_scale >/dev/null 2>&1 || true
  fi
  set_app_locale "$orig_locales" >/dev/null 2>&1 || true
  adbs shell am force-stop "$app_id" >/dev/null 2>&1 || true
}
acceptance_extra_cleanup() { restore_device; }

run_once() {
  local name="$1" locale="$2" night="$3" density="$4" font="$5"
  say ""
  say "== $name (locale=$locale night=$night density=$density font=$font) =="
  adbs shell pm clear "$app_id" >/dev/null 2>&1 || true
  set_app_locale "$locale" >/dev/null
  adbs shell cmd uimode night "$night" >/dev/null
  if [ "$density" = "reset" ]; then
    adbs shell wm density reset >/dev/null
  else
    adbs shell wm density "$density" >/dev/null
  fi
  adbs shell settings put system font_scale "$font" >/dev/null

  # The expected configuration travels WITH the run, so the device asserts what
  # it is actually rendering at rather than this script asserting what it asked
  # for. `wm density` and `settings put` can both be accepted and not applied.
  #
  # The width extra is OMITTED for the default groups rather than passed empty.
  # `adb shell` concatenates its arguments into one remote command line, so an
  # empty argument does not survive: it vanishes, and everything after it shifts
  # up — `am instrument` then reads `-e relayium.fontScale` as the VALUE of the
  # width key and the next flag as a user id, and the run dies with "Invalid
  # userId" before a single test starts.
  #
  # An array, so the flag and its value are one unit. `${arr[@]+"${arr[@]}"}` is
  # the expansion that is empty-safe under `set -u` on bash 3.2, which is what
  # macOS ships.
  local -a width_arg=()
  if [ "$density" != "reset" ]; then
    width_arg=(-e relayium.smallestWidthDp 320)
  fi

  local log="$out_dir/instrument-$name.log"
  local status
  set +e
  adbs shell am instrument -w -r \
    -e class "$test_class" \
    ${width_arg[@]+"${width_arg[@]}"} \
    -e relayium.fontScale "$font" \
    -e relayium.night "$night" \
    "$test_pkg/$runner" >"$log" 2>&1
  status=$?
  set -e

  # BOTH: `am instrument` exits 0 almost unconditionally, so its status cannot
  # be the judge — but a NON-zero one is real information (adb lost the device,
  # the shell died) that the log-based rule cannot see, so it is not discarded
  # either. The shared judge supplies the positive rule: an exact count, plus
  # every way a run produces no usable result at all.
  if [ "$status" -ne 0 ] || ! "$result_check" "$log" "$expected_tests"; then
    say "-- FAILED under $name (am instrument exit $status):"
    sed -n '/INSTRUMENTATION_STATUS: stack=/,/^INSTRUMENTATION_STATUS_CODE/p' "$log" | head -40 >&2
    restore_device
    fail "$test_class failed under $name"
  fi
  say "-- passed under $name ($expected_tests tests)"
}

# name  locale  night  density  font
#
# Six groups: each maintained language at the device's own density in light, and
# each again at 320 dp with font scale 2.0 in BOTH appearances. Dark is not a
# free pass at the narrow width — a contrast or an overflow can differ between
# the two — so neither is inferred from the other.
run_once en-light-default-font1 en-US no reset 1.0
run_once zh-light-default-font1 zh-CN no reset 1.0
run_once en-light-320dp-font2 en-US no "$dp320_density" 2.0
run_once zh-light-320dp-font2 zh-CN no "$dp320_density" 2.0
run_once en-dark-320dp-font2 en-US yes "$dp320_density" 2.0
run_once zh-dark-320dp-font2 zh-CN yes "$dp320_density" 2.0

restore_device

say ""
say "== the Inbox surface passed all six groups =="
say "   en/zh light at this device's own density and font scale 1.0"
say "   en/zh light AND dark at 320 dp with font scale 2.0"
say "   instrumentation logs under $out_dir"
say "   NOT claimed here: navigation, SAF, share-target ingress or a live account"
completed=1
