#!/usr/bin/env bash
#
# **The shared host, on a real device: five destinations, the bounded picker
# lease, the share ingress, and the scanner entry point.**
#
#   ./scripts/android-host-acceptance.sh
#
# This is the offline half of the shared-host evidence. `HostIntegrationTest`
# drives the REAL `MainActivity` — the Activity the user launches, the ViewModel
# it creates, and the activity-result launchers registered in the real
# composition — and asserts that
#
#   * all five destinations exist, are labelled, carry tab semantics, and open
#     their own surface rather than a placeholder;
#   * the foreground claim both presence features read is APP-WIDE: selecting
#     another destination, or a configuration recreation, never drops it;
#   * an owned picker's lease expires on its ORIGINAL deadline, a recreation
#     does not renew it, and a late result cannot revive a retired operation;
#   * a share is STAGED and nothing is sent, an account-bound destination is
#     gated rather than hidden, a staged share stays reachable across
#     navigation, discarding releases it, and a recreation does not replay the
#     intent that was already handled;
#   * a foreign-origin link is refused without joining, and a valid link
#     PREFILLS without connecting;
#   * the scanner opens only from its own button;
#   * and that the configuration corner the harness asked for is the one the
#     app is actually running under — asserted on the device, because a shell
#     command returning 0 says a setting was accepted, not that it applied.
#
# ## The configuration corners
#
# The same class runs under two corners — English / light / default density /
# font 1, and Simplified Chinese / dark / 320 dp / font 2 — because the fifth
# destination is exactly the change that pushes the bar from its even form into
# its scrolling one. A run that only proved the wide default would prove nothing
# about whether Inbox and Account are still reachable on a narrow screen at a
# large font.
#
# ## What this script does NOT prove, and must not be read as proving
#
# Three gates need something this process cannot produce, and each belongs to
# the run that owns a device, a backend and a separate sender:
#
#   * a real external file share, which must come from a separate-UID sender
#     APK — this app's own provider is refused by admission, by design;
#   * the camera PERMISSION journey (revoke, clear flags, open, recreate while
#     the dialog is up, grant, assert one usable camera and no second prompt);
#   * the wall-clock lease: Home pressed from inside `DocumentsUI`, and a real
#     SAF round trip.
#
# The lease arithmetic below runs against the product's own clock seam — only
# `now` is shifted, through a DEBUG-only offset with no field behind it in
# release — so what is asserted is the shipped rule rather than a shortened
# copy of it. That is evidence about the rule, not about the device journey.
set -Eeuo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$here/.." && pwd)"

adb="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-}}/platform-tools/adb"
serial="${ANDROID_SERIAL:-}"
gradle_bin="${RELAYIUM_GRADLE:-$repo/apps/android/gradlew}"
app_id="com.relayium.android.debug"
test_pkg="$app_id.test"
runner="androidx.test.runner.AndroidJUnitRunner"
test_class="com.relayium.android.integration.HostIntegrationTest"
# A dead loopback port. Nothing here reaches the network: the host cases assert
# staging, navigation and refusals, none of which submit anything. The origin
# exists so a reflective override cannot quietly fall back to production.
origin="http://10.0.2.2:1"
out_dir="${RELAYIUM_HOST_OUT:-$repo/apps/android/build/host-acceptance}"

say() { printf '%s\n' "$*" >&2; }
fail() { say "ERROR: $*"; exit 1; }

[ -x "$adb" ] || fail "adb not found at $adb; set ANDROID_HOME or ANDROID_SDK_ROOT"
devices="$("$adb" devices | awk 'NR>1 && $2=="device" {print $1}')"
[ -n "$devices" ] || fail "no attached device; start an emulator first"
[ -n "$serial" ] || serial="$(printf '%s\n' "$devices" | head -1)"
printf '%s\n' "$devices" | grep -qx "$serial" || fail "ANDROID_SERIAL=$serial not attached ($devices)"
adbs() { "$adb" -s "$serial" "$@"; }

mkdir -p "$out_dir"

say "== building the debug APK and its instrumentation =="
[ -x "$gradle_bin" ] || gradle_bin="gradle"
( cd "$repo/apps/android" && "$gradle_bin" -Prelayium.android=true \
    :app:assembleDebug :app:assembleDebugAndroidTest ) \
  || fail "the build failed"

apk="$repo/apps/android/app/build/outputs/apk/debug/app-debug.apk"
test_apk="$repo/apps/android/app/build/outputs/apk/androidTest/debug/app-debug-androidTest.apk"
[ -f "$apk" ] || fail "no debug APK at $apk"
[ -f "$test_apk" ] || fail "no instrumentation APK at $test_apk"

say "== installing =="
adbs install -r -g "$apk" >/dev/null || fail "could not install the app"
adbs install -r "$test_apk" >/dev/null || fail "could not install the instrumentation"

# ── the device settings this run changes, and puts back ─────────────────────
#
# Read BEFORE anything is changed, so a failure part-way through still restores
# what it found rather than what it assumed.
orig_density_override="$(adbs shell wm density | tr -d '\r' | awk '/Override density/ {print $3}')"
orig_font="$(adbs shell settings get system font_scale | tr -d '\r')"
[ -n "$orig_font" ] && [ "$orig_font" != "null" ] || orig_font="1.0"
orig_night="$(adbs shell cmd uimode night | tr -d '\r' | awk -F': ' '{print $2}')"
[ -n "$orig_night" ] || orig_night="no"

# ── the app locale, captured BEFORE anything changes it ─────────────────────
#
# Clearing the override is NOT a restore. A device whose owner had pinned this
# app to a language would lose that setting to a test run, silently, and the run
# would report success. So the prior value is read and put back.
#
# It is read FIRST, and an unreadable answer aborts the run before a single
# setting is touched: a harness that mutated state it could not put back is
# worse than one that refused to start.
#
# `[...]` is the value in `cmd locale get-app-locales` output and is empty when
# there is no override, so the brackets — not the emptiness — are what says the
# read succeeded.
raw_locale="$(adbs shell cmd locale get-app-locales "$app_id" 2>&1 | tr -d '\r' || true)"
case "$raw_locale" in
  *"["*"]"*) ;;
  *) fail "could not read the app's current locale (got: ${raw_locale:-<nothing>}); refusing to change a setting this run could not put back" ;;
esac
orig_locale="$(printf '%s' "$raw_locale" | sed -n 's/.*\[\(.*\)\].*/\1/p' | head -1)"
# Validated before it is ever interpolated into a remote shell command. It came
# from parsing command output, and a locale tag is letters, digits, hyphens,
# underscores and commas — or it is not one, and does not belong in a string the
# device's shell will parse.
case "$orig_locale" in
  *[!A-Za-z0-9,_-]*) fail "the app's current locale is not a plausible tag ('$orig_locale'); refusing to interpolate it into a device command" ;;
esac
say "== app locale before this run: ${orig_locale:-<none>} =="

restore() {
  # Best effort and never fatal: this runs from the trap, including on the
  # failure paths, and a restore that aborted would leave the device in the
  # test's configuration for whatever runs next.
  set +e
  if [ -n "$orig_density_override" ]; then
    adbs shell wm density "$orig_density_override" >/dev/null
  else
    adbs shell wm density reset >/dev/null
  fi
  adbs shell settings put system font_scale "$orig_font" >/dev/null
  adbs shell cmd uimode night "$orig_night" >/dev/null
  # The captured value, not a blanket clear. Sent through the same quoting path
  # as every other locale change, so an EMPTY prior override is restored as an
  # empty override rather than vanishing on the way.
  set_app_locale "$orig_locale" >/dev/null
  set -e
}
trap restore EXIT

# 320 dp at this device's own height: the density that makes the shortest
# dimension exactly 320 dp, computed rather than assumed, because a hard-coded
# density is a different screen on every emulator image.
size="$(adbs shell wm size | tr -d '\r' | awk -F': ' 'END {print $2}')"
px_w="${size%x*}"
dp320_density="$(( px_w * 160 / 320 ))"

# The locale change, in the one form that survives the trip.
#
# `adb shell a b c` does not pass an argument vector: it JOINS the arguments
# with spaces and the device's shell re-splits the result. An empty argument
# therefore disappears completely — `--locales ""` arrives as `--locales` with
# no value at all, which is the defect that made the old restore path do
# something other than what it read. Quoting on the host does not help, because
# the host's quotes are consumed by the host's shell.
#
# So the whole remote command is built as ONE string with the value quoted for
# the DEVICE's shell: `''` reaches `cmd locale` as a genuine empty argument.
# The value is validated against a locale-tag alphabet first — it is being
# placed inside a command another shell will parse.
set_app_locale() {
  local value="${1:-}"
  case "$value" in
    *[!A-Za-z0-9,_-]*) fail "refusing to set an implausible locale value ('$value')" ;;
  esac
  adbs shell "cmd locale set-app-locales '$app_id' --user current --locales '$value'"
}

# name locale night density font expected-smallest-width-dp
#
# The last column is what the device must actually REPORT. "any" is the default
# density, where the dp depends on the emulator image and there is nothing
# specific to assert; 320 is the corner that exists precisely because it is the
# width the five-destination bar has to survive.
configs=(
  "en-light-default-font1 en-US no reset 1.0 any"
  "zh-dark-320dp-font2 zh-CN yes $dp320_density 2.0 320"
)

# The class's @Test methods. The run must EXECUTE all of them: an
# INSTRUMENTATION_CODE of -1 is also what a ZERO-test run reports, so the count
# is the only thing that distinguishes "everything passed" from "nothing ran".
# Bump this deliberately when a case is added.
expected_tests=20

failures=0
for cfg in "${configs[@]}"; do
  read -r name locale night density font expect_dp <<<"$cfg"
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

  log="$out_dir/instrument-$name.log"
  set +e
  # The expectation is handed to the TEST, which asserts what the device
  # actually reports. A shell command returning 0 says the setting was
  # accepted, not that the app is running under it — an app-locale override
  # that silently failed to apply, or a density the window manager clamped,
  # would leave a run reporting a corner it never entered.
  adbs shell am instrument -w -r \
    -e class "$test_class" \
    -e relayium.origin "$origin" \
    -e relayium.expect.locale "$locale" \
    -e relayium.expect.night "$night" \
    -e relayium.expect.font "$font" \
    -e relayium.expect.dp "$expect_dp" \
    "$test_pkg/$runner" >"$log" 2>&1
  status=$?
  set -e

  # The ORIGINAL exit is kept and reported alongside the semantic verdict: `am
  # instrument` exits 0 almost unconditionally — including when the app crashed
  # or nothing ran at all — so the exit alone proves nothing, and discarding it
  # would lose the one signal that says adb itself failed.
  say "-- am instrument original exit: $status"

  # The SHARED checker, not a second copy of the rule. It is a program rather
  # than a function precisely so `scripts/test/android-instrumentation-result-test.mjs`
  # can execute it against recorded logs; re-implementing the count here would
  # be testing a copy of the rule instead of the rule.
  if [ "$status" -ne 0 ] \
     || ! "$here/lib/instrumentation-result.sh" "$log" "$expected_tests"; then
    say "-- FAILED under $name (am instrument original exit $status):"
    # The diagnostic must never decide the script's exit status.
    #
    # `… | head -40` under `pipefail` is a trap: `head` closes the pipe after 40
    # lines, the producer takes SIGPIPE, the pipeline reports 141, and `set -e`
    # aborts the run — turning an informative failure into an exit code that
    # describes the PRINTER rather than the tests. A previous run ended at 141
    # for exactly this reason.
    #
    # `awk` consumes the whole file and bounds its own output, so there is no
    # early close and nothing to signal.
    awk '/INSTRUMENTATION_STATUS: stack=/,/^INSTRUMENTATION_STATUS_CODE/ {
           if (shown < 40) { print; shown++ }
         }' "$log" >&2 || true
    failures=$((failures + 1))
    continue
  fi
  say "-- $name PASSED ($expected_tests cases)"
done

say ""
if [ "$failures" -ne 0 ]; then
  say "android-host-acceptance: FAILED in $failures of ${#configs[@]} configuration(s)"
  say "logs: $out_dir"
  exit 1
fi

say "android-host-acceptance: PASSED in all ${#configs[@]} configurations"
say "logs: $out_dir"
say ""
say "This run proves the host's own rules. It does NOT prove the real external"
say "file share, the camera permission journey, or the wall-clock picker lease"
say "with a real SAF round trip — those need a separate sender APK, a device"
say "permission sequence, and Home pressed from inside DocumentsUI."
