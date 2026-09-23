#!/usr/bin/env bash
#
# **A12: the real `relayium pair` CLI ↔ the Android app on an emulator, over a
# real code, on a real server.**
#
#   ./scripts/interop/cli-android-acceptance.sh
#
# Needs an attached emulator or device (ANDROID_SERIAL picks one), the Android
# SDK (ANDROID_HOME) and a Gradle (RELAYIUM_GRADLE, else the wrapper). It does
# not create an emulator. On the hosted lane it runs inside
# `android-interop.yml`'s emulator step, after the browser cell.
#
# The Android half is the unchanged `InteropAcceptanceTest` (the app's own
# `TransferViewModel`) — the one `android-interop-acceptance.sh` drives against
# a browser — and the CLI half is `scripts/interop/cli-android-peer.mjs` playing
# the peer side of its in-band protocol with a real `relayium pair`.
#
# Cells, each required before the run may pass:
#   * the CLI as link INITIATOR and as RESPONDER (the hub's coin flip, read off
#     the CLI's own `linked with …` line);
#   * the code minted by the CLI (`relayium pair`, logged in) and by the
#     account API on behalf of a third party (the CLI then JOINS with
#     `relayium pair CODE`; the Android instrumentation always joins);
#   * cancel=none (both batches each way, exact bytes both ways) and
#     cancel=receive (Android stops the CLI's first batch on acceptance; the
#     second batch on the same link must then complete).
# Not played: the browser cell's `send`-cancel (the peer must hold a write and
# announce it while holding, which a CLI process cannot) — see the peer file.
#
# Evidence level: EMULATOR LOOPBACK (10.0.2.2 → the host's loopback server;
# host candidates, no relay). Not a physical device, not NAT, not WAN.
set -Eeuo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$here/../.." && pwd)"
# shellcheck source-path=SCRIPTDIR
# shellcheck source=../lib/local-acceptance.sh
source "$here/../lib/local-acceptance.sh"

max_rounds="${RELAYIUM_CLI_ANDROID_ROUNDS:-8}"
gradle_bin="${RELAYIUM_GRADLE:-$repo/apps/android/gradlew}"
adb="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-}}/platform-tools/adb"
serial="${ANDROID_SERIAL:-}"
app_id="com.relayium.android.debug"
test_pkg="$app_id.test"
runner="androidx.test.runner.AndroidJUnitRunner"

hex_of() { printf '%s' "$1" | od -An -tx1 | tr -d ' \n'; }
adbs() { "$adb" -s "$serial" "$@"; }

acceptance_begin

say "== building the local server and the CLI under test =="
( cd "$repo/server" && go build -o "$run_root/relayium-server" . ) || fail "the server failed to build"
( cd "$repo/server" && go build -o "$run_root/relayium" ./cmd/relayium ) || fail "the CLI failed to build"
cli_bin="$run_root/relayium"

# Built here unless the caller already built THIS tree's APKs in the same job
# (`RELAYIUM_ANDROID_PREBUILT=1`, set by the hosted lane right after
# `android-interop-acceptance.sh` built them from the same checkout).
app_apk="$repo/apps/android/app/build/outputs/apk/debug/app-debug.apk"
test_apk="$repo/apps/android/app/build/outputs/apk/androidTest/debug/app-debug-androidTest.apk"
if [ "${RELAYIUM_ANDROID_PREBUILT:-0}" != 1 ]; then
  say "== building the debug APK and its instrumentation =="
  [ -x "$gradle_bin" ] || gradle_bin="gradle"
  ( cd "$repo/apps/android" && "$gradle_bin" -Prelayium.android=true \
      :app:assembleDebug :app:assembleDebugAndroidTest >"$run_root/gradle.log" 2>&1 ) \
    || fail "the Android build failed: $(tail -30 "$run_root/gradle.log")"
fi
[ -f "$app_apk" ] || fail "no debug APK at $app_apk"
[ -f "$test_apk" ] || fail "no instrumentation APK at $test_apk"

[ -x "$adb" ] || fail "adb not found at $adb; set ANDROID_HOME"
devices="$("$adb" devices | awk 'NR>1 && $2=="device" {print $1}')"
[ -n "$devices" ] || fail "no attached device; start an emulator first"
[ -n "$serial" ] || serial="$(printf '%s\n' "$devices" | head -1)"
printf '%s\n' "$devices" | grep -qx "$serial" || fail "ANDROID_SERIAL=$serial is not attached"
say "-- driving $serial"
adbs install -r -t "$app_apk" >/dev/null || fail "could not install the app"
adbs install -r -t "$test_apk" >/dev/null || fail "could not install the instrumentation"

acceptance_start_server
acceptance_create_account

emulator_origin="http://10.0.2.2:$server_port"
adbs shell setprop debug.relayium.backend "$emulator_origin" || fail "could not point the app at $emulator_origin"
[ "$(adbs shell getprop debug.relayium.backend | tr -d '\r')" = "$emulator_origin" ] \
  || fail "the backend property did not take"

umask 077
xdg="$run_root/xdg"
mkdir -p "$xdg/relayium"
ACCOUNT_TOKEN="$account_token" python3 - "$xdg/relayium/credentials" "$origin" "$account_email" <<'PY'
import json, os, sys
path, server, email = sys.argv[1:4]
fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
with os.fdopen(fd, "w") as f:
    json.dump({"server": server, "access_token": os.environ["ACCOUNT_TOKEN"], "account_email": email}, f)
PY
printf 'header = "Authorization: Bearer %s"\n' "$account_token" >"$run_root/auth.conf"
api_mint() {
  curl -sf --max-time 20 -X POST "$origin/api/pair" --config "$run_root/auth.conf" \
    -H 'Content-Type: application/json' -d '{}' \
    | python3 -c 'import json,sys;print(json.load(sys.stdin).get("code",""))'
}

seen_initiator=0; seen_responder=0
seen_code_cli=0; seen_code_api=0
seen_none=0; seen_receive=0
round=0
while [ "$round" -lt "$max_rounds" ]; do
  round=$((round + 1))
  if [ "$round" -gt 1 ]; then
    say "-- waiting out the server's per-IP join budget before round $round"
    sleep 65
  fi
  case "$round" in
    1) code_role=cli; cancel=none ;;
    2) code_role=api; cancel=receive ;;
    3) code_role=api; cancel=none ;;
    *) if [ $((round % 2)) -eq 0 ]; then code_role=cli; else code_role=api; fi; cancel=none ;;
  esac
  say ""
  say "== round $round: code minted by the $code_role, cancel=$cancel =="

  code=""
  if [ "$code_role" = api ]; then
    code="$(api_mint)" || fail "could not mint a code through the account API"
    [ -n "$code" ] || fail "the account API minted no code"
  fi
  plan="$run_root/plan-$round.json"
  python3 "$here/cli-matrix-plan.py" android "$run_root" "$round" "$code_role" "$cancel" "$code" >"$plan" \
    || fail "could not build round $round's plan"
  read_plan() { python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); print(eval(sys.argv[2]))' "$plan" "$1"; }
  android_hex="$(hex_of "$(read_plan 'd["androidMessage"]')")"
  post_hex="$(hex_of "$(read_plan 'd["postMessage"]')")"
  send_name="$(read_plan 'd["android"]["sendName"]')"
  send_size="$(read_plan 'd["android"]["sendSize"]')"
  send_seed="$(read_plan 'd["android"]["sendSeed"]')"

  cli_out="$run_root/cli-$round.json"
  code_file="$run_root/code-$round.txt"
  node "$here/cli-android-peer.mjs" --plan "$plan" --out "$cli_out" --cli "$cli_bin" \
    --xdg "$xdg" --origin "$origin" --code-file "$code_file" >"$run_root/cli-peer-$round.log" 2>&1 &
  peer_pid=$!
  register_child "cli-peer-$round" "$peer_pid"
  for _ in $(seq 1 120); do [ -s "$code_file" ] && break; kill -0 "$peer_pid" 2>/dev/null || break; sleep 0.25; done
  [ -s "$code_file" ] || fail "the CLI half never produced a code: $(tail -30 "$run_root/cli-peer-$round.log")"
  code="$(cat "$code_file")"

  adbs shell pm clear "$app_id" >/dev/null 2>&1 || fail "could not reset the app's data"
  device_out="cli-interop-$round.json"
  set +e
  adbs shell am instrument -w -r \
    -e class com.relayium.android.InteropAcceptanceTest \
    -e relayium.origin "$emulator_origin" \
    -e relayium.code "$code" \
    -e relayium.out "$device_out" \
    -e relayium.messageHex "$android_hex" \
    -e relayium.postCancelHex "$post_hex" \
    -e relayium.sendName "$send_name" \
    -e relayium.sendSize "$send_size" \
    -e relayium.sendSeed "$send_seed" \
    -e relayium.textRole accept \
    -e relayium.cancel "$cancel" \
    "$test_pkg/$runner" >"$run_root/instrument-$round.log" 2>&1
  instrument_status=$?
  set -e
  [ "$instrument_status" -eq 0 ] || fail "adb could not run the Android half: $(tail -20 "$run_root/instrument-$round.log")"
  grep -q '^INSTRUMENTATION_CODE: -1$' "$run_root/instrument-$round.log" \
    || fail "the Android half did not run to completion: $(tail -40 "$run_root/instrument-$round.log")"
  if grep -qE '^INSTRUMENTATION_STATUS_CODE: (-1|-2)$' "$run_root/instrument-$round.log"; then
    fail "the Android half FAILED: $(sed -n '/INSTRUMENTATION_STATUS: stack=/,/^INSTRUMENTATION_STATUS_CODE/p' "$run_root/instrument-$round.log" | head -40)
CLI half: $(tail -40 "$run_root/cli-peer-$round.log")"
  fi
  wait "$peer_pid" || fail "the CLI half failed: $(tail -60 "$run_root/cli-peer-$round.log")"
  sed 's/^/   /' "$run_root/cli-peer-$round.log" >&2
  android_out="$run_root/android-$round.json"
  adbs exec-out run-as "$app_id" cat "files/$device_out" >"$android_out" 2>/dev/null \
    || fail "the Android half wrote no observation"

  role="$(python3 "$here/cli-android-oracle.py" "$plan" "$cli_out" "$android_out")" \
    || fail "round $round did not agree"
  case "$role" in
    initiator) seen_initiator=1 ;;
    responder) seen_responder=1 ;;
    *) fail "the oracle named no role: '$role'" ;;
  esac
  [ "$code_role" = cli ] && seen_code_cli=1
  [ "$code_role" = api ] && seen_code_api=1
  [ "$cancel" = none ] && seen_none=1
  [ "$cancel" = receive ] && seen_receive=1
  adbs shell am force-stop "$app_id" >/dev/null 2>&1 || true
  say "-- round $round passed (CLI was $role)"
  if [ "$seen_initiator$seen_responder$seen_code_cli$seen_code_api$seen_none$seen_receive" = 111111 ]; then
    break
  fi
done

[ "$seen_initiator" = 1 ] || fail "never observed the CLI as INITIATOR against Android in $round rounds"
[ "$seen_responder" = 1 ] || fail "never observed the CLI as RESPONDER against Android in $round rounds"
[ "$seen_code_cli$seen_code_api" = 11 ] || fail "both code roles were not exercised"
[ "$seen_none$seen_receive" = 11 ] || fail "both cancel modes were not exercised"
assert_run_was_local

say ""
say "== CLI ↔ Android emulator: both link roles, CLI- and API-minted codes, text both ways,"
say "   multi-entry batches both ways, a receive-cancel with a retry — EMULATOR LOOPBACK evidence =="
completed=1
