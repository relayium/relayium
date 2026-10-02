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

# >>> diagnostics: owned CLI-peer lifecycle
#
# Is this owned child still running? `kill -0` also answers yes for an exited,
# unreaped process, so the process state is read. A state query is NOT proof
# of identity once the kernel has reused a PID; it is only asked between this
# run starting the child and confirming its exit, and every exited child's
# registry slot is retired at once, which narrows the reuse window.
owned_child_running() {
  local state
  state="$(ps -o stat= -p "$1" 2>/dev/null || true)"
  state="${state#"${state%%[![:space:]]*}"}"
  [ -n "$state" ] && [ "${state#Z}" = "$state" ]
}

# Blank exactly the one cleanup-registry slot whose label AND pid match; leave
# every other slot alone; fail on zero or several. bash reaps its children as
# they exit, so an exited child's PID may be reused, and the cleanup trap
# signals every PID still registered.
retire_owned_child() {
  local label="$1" pid="$2" i matched=0
  for i in "${!child_pids[@]}"; do
    if [ "${child_pids[$i]}" = "$pid" ] && [ "${child_labels[$i]}" = "$label" ]; then
      child_pids[i]=""
      matched=$((matched + 1))
    fi
  done
  [ "$matched" -eq 1 ] || fail "the exited $label (pid $pid) matched $matched registry slots, not one"
}

# Before a FAILURE while this round's CLI peer may still be running: TERM it
# (its handler writes its observation), give it 5 seconds, KILL it if it is
# still there, collect it, and retire its slot — so the `fail` that follows
# never waits out the peer's own multi-minute bounds and the cleanup trap never
# signals its reaped PID.
stop_cli_peer() {
  local waited=0
  [ -n "${peer_pid:-}" ] || return 0
  if owned_child_running "$peer_pid"; then
    kill -TERM "$peer_pid" 2>/dev/null || true
    while owned_child_running "$peer_pid" && [ "$waited" -lt 50 ]; do
      sleep 0.1
      waited=$((waited + 1))
    done
    if owned_child_running "$peer_pid"; then
      kill -KILL "$peer_pid" 2>/dev/null || true
    fi
  fi
  wait "$peer_pid" 2>/dev/null || true
  retire_owned_child "cli-peer-$round" "$peer_pid"
  peer_pid=""
}

# On the SUCCESS path: collect the peer's status, retire its slot at once, and
# hand the status back for the caller's verdict.
reap_cli_peer() {
  local status=0
  wait "$peer_pid" || status=$?
  retire_owned_child "cli-peer-$round" "$peer_pid"
  peer_pid=""
  return "$status"
}
# <<< diagnostics: owned CLI-peer lifecycle

# >>> diagnostics: bounded report capture
#
# The early, diagnosis-only read of the Android half's report, with its OWN
# 10-second budget: a wedged `adb exec-out` must never stand between the round
# and its primary verdict. One fixed argv (no shell, no pipe), stdout straight
# into the private file, stderr discarded. On timeout Python kills and reaps
# only that adb client process — never the adb server, the daemon or the
# device. Exit 0 = read, 3 = timed out, anything else = not read.
capture_android_report() {
  python3 - "$adb" "$serial" "$app_id" "files/$device_out" "$1" <<'PY'
import subprocess, sys
adb, serial, app_id, path, dest = sys.argv[1:6]
try:
    with open(dest, "wb") as fh:
        done = subprocess.run([adb, "-s", serial, "exec-out", "run-as", app_id, "cat", path],
                              stdin=subprocess.DEVNULL, stdout=fh, stderr=subprocess.DEVNULL, timeout=10)
except subprocess.TimeoutExpired:
    sys.exit(3)
except OSError:
    sys.exit(4)
sys.exit(0 if done.returncode == 0 else 1)
PY
}
# <<< diagnostics: bounded report capture

# >>> diagnostics: android report summary
#
# The Android half writes its report from a `finally`, so a FAILED round still
# leaves one — with the app's terminal phase, error key and counters. This
# prints a type-checked, limited summary of it BEFORE any instrumentation
# verdict. It is diagnosis only: it never decides anything, a missing or
# malformed report is reported as such, and no file name, transcript or
# message text is echoed — lists are counted, scalars are validated, and
# anything else is shown as `invalid`.
summarize_android_report() {
  python3 - "$1" <<'PY'
import json, re, sys
try:
    with open(sys.argv[1], encoding="utf-8") as fh:
        d = json.load(fh)
except Exception as err:
    print("unreadable (%s)" % type(err).__name__)
    sys.exit(0)
if not isinstance(d, dict):
    print("unreadable (not an object)")
    sys.exit(0)
out = []
def show(key, check):
    if key not in d:
        out.append("%s=absent" % key)
        return
    v = d[key]
    ok, text = check(v)
    out.append("%s=%s" % (key, text if ok else "invalid"))
boolean = lambda v: (isinstance(v, bool), "true" if v is True else "false")
count = lambda v: (isinstance(v, int) and not isinstance(v, bool) and 0 <= v < 10**9, str(v))
listed = lambda v: (isinstance(v, list) and all(isinstance(x, str) for x in v), "%d" % len(v) if isinstance(v, list) else "")
phase = lambda v: (isinstance(v, str) and re.fullmatch(r"[A-Z_]{1,40}", v) is not None, str(v))
errkey = lambda v: (v is None or (isinstance(v, str) and re.fullmatch(r"[a-z0-9_]{1,64}", v) is not None),
                    "null" if v is None else str(v))
show("complete", boolean)
show("offered", listed)
show("treeAfterCancel", listed)
show("cleanupIncompleteAfterCancel", boolean)
show("finalPhase", phase)
show("finalErrorKey", errkey)
show("finalPromptId", count)
show("finalAwaitingFolder", boolean)
show("finalSavedBatchCount", count)
show("finalFileLaneDown", boolean)
show("finalCleanupIncomplete", boolean)
print(" ".join(out))
PY
}
# <<< diagnostics: android report summary

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
  # The plan alone decides the receive gate (an ACTIVE receive cancel: the
  # instrumentation holds the accepted batch's first real write). Only this
  # CLI cell ever passes the opt-in; the browser cell never does.
  receive_gate="$(read_plan 'd["receiveGate"] or ""')"
  gate_args=()
  case "$receive_gate" in
    "") ;;
    first-write) gate_args=(-e relayium.receiveGate first-write) ;;
    *) fail "the plan names an unknown receive gate '$receive_gate'" ;;
  esac

  cli_out="$run_root/cli-$round.json"
  code_file="$run_root/code-$round.txt"
  node "$here/cli-android-peer.mjs" --plan "$plan" --out "$cli_out" --cli "$cli_bin" \
    --xdg "$xdg" --origin "$origin" --code-file "$code_file" >"$run_root/cli-peer-$round.log" 2>&1 &
  peer_pid=$!
  register_child "cli-peer-$round" "$peer_pid"
  for _ in $(seq 1 120); do [ -s "$code_file" ] && break; kill -0 "$peer_pid" 2>/dev/null || break; sleep 0.25; done
  # >>> diagnostics: code-file and reset failures
  if [ ! -s "$code_file" ]; then
    stop_cli_peer
    fail "the CLI half never produced a code: $(tail -30 "$run_root/cli-peer-$round.log")"
  fi
  code="$(cat "$code_file")"

  if ! adbs shell pm clear "$app_id" >/dev/null 2>&1; then
    stop_cli_peer
    fail "could not reset the app's data"
  fi
  # <<< diagnostics: code-file and reset failures
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
    ${gate_args[@]+"${gate_args[@]}"} \
    "$test_pkg/$runner" >"$run_root/instrument-$round.log" 2>&1
  instrument_status=$?
  set -e
  # >>> diagnostics: instrumentation verdicts
  #
  # The Android half's own report, read and summarised BEFORE any verdict
  # below, so a failed round says which state the app ended in. Best-effort and
  # diagnosis only: the read or the summary failing changes nothing, and the
  # authoritative read after the CLI half still decides the round.
  early_report="$run_root/android-$round.early.json"
  capture_status=0
  capture_android_report "$early_report" || capture_status=$?
  if [ "$capture_status" -eq 0 ] && [ -s "$early_report" ]; then
    say "-- Android report, round $round (diagnostic only): $(summarize_android_report "$early_report" || echo 'unreadable (summary failed)')"
  elif [ "$capture_status" -eq 3 ]; then
    say "-- Android report, round $round (diagnostic only): not retrievable (read timed out after 10s)"
  else
    say "-- Android report, round $round (diagnostic only): not retrievable"
  fi
  if [ "$instrument_status" -ne 0 ]; then
    stop_cli_peer
    fail "adb could not run the Android half: $(tail -20 "$run_root/instrument-$round.log")"
  fi
  if ! grep -q '^INSTRUMENTATION_CODE: -1$' "$run_root/instrument-$round.log"; then
    stop_cli_peer
    fail "the Android half did not run to completion: $(tail -40 "$run_root/instrument-$round.log")"
  fi
  if grep -qE '^INSTRUMENTATION_STATUS_CODE: (-1|-2)$' "$run_root/instrument-$round.log"; then
    stop_cli_peer
    fail "the Android half FAILED: $(sed -n '/INSTRUMENTATION_STATUS: stack=/,/^INSTRUMENTATION_STATUS_CODE/p' "$run_root/instrument-$round.log" | head -40)
CLI half: $(tail -40 "$run_root/cli-peer-$round.log")"
  fi
  peer_status=0
  reap_cli_peer || peer_status=$?
  [ "$peer_status" -eq 0 ] || fail "the CLI half failed (exit $peer_status): $(tail -60 "$run_root/cli-peer-$round.log")"
  # <<< diagnostics: instrumentation verdicts
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
