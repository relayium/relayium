#!/usr/bin/env bash
#
# **The Android UI session against a real browser, through the REAL system
# pickers.**
#
#   ./scripts/android-ui-session-acceptance.sh
#
# `android-interop-acceptance.sh` proves the wire in both directions, but it
# stubs ONE thing: the folder/file picker, because the grant a same-uid
# provider gives is the grant the picker would return. This run is the evidence
# for that stub — the one honest gap it leaves. `UiSessionAcceptanceTest` drives
# the real `MainActivity` join FORM, the real Accept button, the real system
# DocumentsUI (through UIAutomator) for both a folder pick and a file pick, and
# an Activity RECREATION in the middle of the live session, with the bytes in
# both directions compared by SHA-256.
#
# It is one round (no cancel, verification at its shipped default). Everything
# else — the throwaway server, the built Web bundle, the real browser peer, the
# pairing code, the isolation — is exactly `scripts/lib/local-acceptance.sh`,
# the same library the wire acceptance uses.
#
# ## What a green run does NOT prove
#
# An AOSP emulator image with no Google Play services, on host ICE candidates —
# not a physical device, its radios, its SAF providers or its power management.
# The system DocumentsUI here is the AOSP one; a vendor's own files app may
# label its affordances differently.
set -Eeuo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$here/.." && pwd)"
# shellcheck source-path=SCRIPTDIR
# shellcheck source=lib/local-acceptance.sh
source "$here/lib/local-acceptance.sh"

gradle_bin="${RELAYIUM_GRADLE:-$repo/apps/android/gradlew}"
adb="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-}}/platform-tools/adb"
serial="${ANDROID_SERIAL:-}"
app_id="com.relayium.android.debug"
test_pkg="$app_id.test"
runner="androidx.test.runner.AndroidJUnitRunner"

# Deliberately whitespace-significant and non-ASCII, carried as hex through
# `am instrument` for the same reason the wire acceptance does it.
android_message="$(printf '%b' "android → web (UI): 端到端 · 0123456789\n\tindented   ")"
hex_of() { printf '%s' "$1" | od -An -tx1 | tr -d ' \n'; }
android_message_hex="$(hex_of "$android_message")"

require_emulator() {
  [ -x "$adb" ] || fail "adb not found at $adb; set ANDROID_HOME or ANDROID_SDK_ROOT"
  local devices
  devices="$("$adb" devices | awk 'NR>1 && $2=="device" {print $1}')"
  [ -n "$devices" ] || fail "no attached device; start an emulator first (this run does not create one)"
  [ -n "$serial" ] || serial="$(printf '%s\n' "$devices" | head -1)"
  printf '%s\n' "$devices" | grep -qx "$serial" || fail "ANDROID_SERIAL=$serial not attached: $devices"
  say "-- driving $serial"
}
adbs() { "$adb" -s "$serial" "$@"; }

acceptance_begin

say "== building the local server =="
( cd "$repo/server" && go build -o "$run_root/relayium-server" . ) || fail "the server failed to build"

say "== building the Web bundle =="
( cd "$repo/web" && npx vite build >"$run_root/web-build.log" 2>&1 ) \
  || fail "the Web bundle failed to build: $(tail -20 "$run_root/web-build.log")"
[ -f "$repo/web/dist/index.html" ] || fail "web/dist/index.html is missing after the build"
acceptance_server_static="$repo/web/dist"

say "== building the debug APK and its instrumentation =="
[ -x "$gradle_bin" ] || gradle_bin="gradle"
( cd "$repo/apps/android" && "$gradle_bin" -Prelayium.android=true \
    :app:assembleDebug :app:assembleDebugAndroidTest >"$run_root/gradle.log" 2>&1 ) \
  || fail "the Android build failed: $(tail -30 "$run_root/gradle.log")"
app_apk="$repo/apps/android/app/build/outputs/apk/debug/app-debug.apk"
test_apk="$repo/apps/android/app/build/outputs/apk/androidTest/debug/app-debug-androidTest.apk"

require_emulator
say "== installing =="
adbs install -r -t "$app_apk" >/dev/null || fail "could not install the app"
adbs install -r -t "$test_apk" >/dev/null || fail "could not install the instrumentation"
adbs shell pm clear "$app_id" >/dev/null 2>&1 || true

acceptance_start_server
acceptance_create_account

emulator_origin="http://10.0.2.2:$server_port"
adbs shell setprop debug.relayium.backend "$emulator_origin" || fail "could not point the app at $emulator_origin"
[ "$(adbs shell getprop debug.relayium.backend | tr -d '\r')" = "$emulator_origin" ] \
  || fail "the backend property did not take"
say "-- the app under test is pointed at $emulator_origin"

curl -sf --max-time 10 "$origin/cross-network" | grep -q '<div id="app"' \
  || fail "the server is not serving the built Web app at $origin/cross-network"

umask 077
printf 'header = "Authorization: Bearer %s"\n' "$account_token" >"$run_root/auth.conf"
code="$(curl -sf --max-time 20 -X POST "$origin/api/pair" \
         --config "$run_root/auth.conf" -H 'Content-Type: application/json' -d '{}' \
         | python3 -c 'import json,sys;print(json.load(sys.stdin).get("code",""))')" \
  || fail "could not mint a pairing code"
[ -n "$code" ] || fail "the server minted no pairing code"
say "-- minted $code"

# The one round's shape: the browser sends ONE small file (Android saves it via
# the real folder picker) and Android sends ONE file (the browser saves it).
# Both messages, the terminal handshake, one save each — no cancel, no boundary
# payloads (those are the wire acceptance's job).
android_name="ui-android-to-web.bin"
android_size=4096
android_seed=42
plan="$run_root/plan.json"
browser_out="$run_root/browser.json"
android_out="$run_root/android.json"

RELAYIUM_ANDROID_MESSAGE="$android_message" python3 - "$plan" "$android_message" <<'PLAN' \
  || fail "could not build the plan"
import json, sys
plan_path, android_message = sys.argv[1:]
json.dump({
    "batches": [[{"name": "ui-web-to-android.bin", "size": 2048, "seed": 7}]],
    "expectMessages": [android_message],
    "expectSaved": ["ui-android-to-web.bin"],
    "forbidSaved": [],
}, open(plan_path, "w"), ensure_ascii=False, indent=2)
PLAN

web_message="  web → android (UI):   你好 🌍   "
( cd "$repo/web" && exec node e2e/android-interop.mjs \
    --origin "$origin" --code "$code" --out "$browser_out" \
    --verify default --message "$web_message" --plan "$plan" ) \
  >"$run_root/browser.log" 2>&1 &
browser_pid=$!
register_child "browser-ui" "$browser_pid"

device_out="ui-session.json"
set +e
adbs shell am instrument -w -r \
  -e class com.relayium.android.UiSessionAcceptanceTest \
  -e relayium.origin "$emulator_origin" \
  -e relayium.code "$code" \
  -e relayium.out "$device_out" \
  -e relayium.messageHex "$android_message_hex" \
  -e relayium.sendName "$android_name" \
  -e relayium.sendSize "$android_size" \
  -e relayium.sendSeed "$android_seed" \
  "$test_pkg/$runner" >"$run_root/instrument.log" 2>&1
instrument_status=$?
set -e

[ "$instrument_status" -eq 0 ] \
  || fail "adb could not run the UI session (exit $instrument_status): $(tail -20 "$run_root/instrument.log")"
grep -q '^INSTRUMENTATION_CODE: -1$' "$run_root/instrument.log" \
  || fail "the UI session did not run to completion: $(tail -40 "$run_root/instrument.log")"
if grep -qE '^INSTRUMENTATION_STATUS_CODE: (-1|-2)$' "$run_root/instrument.log"; then
  fail "the UI session FAILED: $(sed -n '/INSTRUMENTATION_STATUS: stack=/,/^INSTRUMENTATION_STATUS_CODE/p' "$run_root/instrument.log" | head -40)"
fi

wait "$browser_pid" || fail "the browser half failed: $(tail -40 "$run_root/browser.log")"

adbs exec-out run-as "$app_id" cat "files/$device_out" >"$android_out" 2>/dev/null \
  || fail "the UI session wrote no observation at files/$device_out"
[ -s "$android_out" ] || fail "the UI session's observation is empty"
python3 -c 'import json,sys; sys.exit(0 if json.load(open(sys.argv[1])).get("complete") else 1)' \
  "$android_out" || fail "the UI session's report is not from a completed round: $(head -c 2000 "$android_out")"

# The bytes both ways, verified by neither half alone: the browser's saved
# record of the Android file, and the Android report's saved record of the
# browser file, each compared to what the sender declared.
RELAYIUM_WEB_MESSAGE="$web_message" RELAYIUM_ANDROID_MESSAGE="$android_message" \
python3 - "$browser_out" "$android_out" <<'CHECK' || fail "the UI session did not agree"
import hashlib, json, os, sys

def body(size, seed):
    return bytes(((i * 31 + seed) & 0xff) for i in range(size))

browser = json.load(open(sys.argv[1]))
android = json.load(open(sys.argv[2]))
problems = []

# android → web: the browser saved the Android file, byte-identical.
want = hashlib.sha256(body(4096, 42)).hexdigest()
got = {f["name"]: f for f in browser.get("receivedFiles", [])}
entry = got.get("ui-android-to-web.bin")
if entry is None:
    problems.append("the browser never saved the Android file through its picker")
elif hashlib.sha256(bytes.fromhex(entry["hex"])).hexdigest() != want:
    problems.append("the Android file's bytes differ at the browser")

# web → android: the Android app saved the browser file through the REAL folder
# picker, byte-identical.
want_web = hashlib.sha256(body(2048, 7)).hexdigest()
saved = {f["name"]: f for f in android.get("saved", [])}
sentry = saved.get("ui-web-to-android.bin")
if sentry is None:
    problems.append("Android never saved the browser file through the system folder picker")
elif sentry["sha256"].lower() != want_web.lower():
    problems.append("the browser file's bytes differ at Android")

# text both ways, through the REAL Accept button and composer.
if android.get("receivedMessage") != os.environ["RELAYIUM_WEB_MESSAGE"]:
    problems.append("Android did not receive the browser's message through the real UI: %r"
                    % (android.get("receivedMessage"),))
android_msg = os.environ["RELAYIUM_ANDROID_MESSAGE"]
if android_msg not in (browser.get("receivedMessages") or []):
    problems.append("the browser never saw the Android reply %r; it saw %r"
                    % (android_msg, browser.get("receivedMessages")))

if not android.get("recreatedMidSession"):
    problems.append("the Activity was not recreated mid-session")
if not android.get("peerConfirmedDone"):
    problems.append("the round closed without the terminal handshake")

if problems:
    for p in problems:
        print("  - %s" % p, file=sys.stderr)
    sys.exit(1)
print("-- UI session agreed: real pickers both directions, bytes identical, "
      "recreation mid-session", file=sys.stderr)
CHECK

adbs shell am force-stop "$app_id" >/dev/null 2>&1 || true
assert_run_was_local

say ""
say "== Android UI session ↔ real browser: real join form, real system folder AND file pickers,"
say "   an Activity recreation mid-session, bytes identical both directions =="
say "   NOT physical-device evidence: AOSP emulator image, AOSP DocumentsUI."
completed=1
