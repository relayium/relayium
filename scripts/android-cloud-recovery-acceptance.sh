#!/usr/bin/env bash
#
# **Recoverable cloud uploads, across a real process death.**
#
#   ./scripts/android-cloud-recovery-acceptance.sh
#
# `android-cloud-acceptance.sh` proves stored transfers work. This proves the
# thing that one cannot: that a large upload interrupted by the PROCESS ENDING
# can be continued, and that what the server ends up holding is byte-for-byte
# what the user chose.
#
# ## Why this is four instrumentation runs and not four assertions
#
# `ActivityScenario.recreate` restarts an Activity inside a living process. It
# is not a process death, and a resumable upload's entire claim is about the
# latter: the encrypted spool, the Keystore-wrapped plan and its content key
# have to survive a `force-stop` and be found again by a process that has never
# seen the user's files. Only the shell can produce that, so the phases are
# separate `@Test` methods and this script is what orders them:
#
#   1. `stageAndInterruptAnUpload` — sign in, stage a 12 MiB selection, let the
#      server commit part of it, stop.
#   2. **`am force-stop`** — the app process is killed. Nothing is cancelled,
#      nothing is discarded, and no cleanup path runs.
#   3. `resumeTheInterruptedUploadInAFreshProcess` — a new process finds the
#      offer, resumes it, and reaches a link.
#   4. `theResumedObjectDecodesToTheOriginalBytes` — the object is downloaded
#      through the app's own receive path into a granted tree and compared by
#      SHA-256 against phase one's fixture. A resumed stream that had been
#      re-encrypted rather than replayed would fail here and nowhere else.
#   5. `historyListsTheObjectAndDeletesItOnConfirmation` — the file list the
#      upload produced, and a confirmed delete.
#
# **The app's data is cleared ONCE, before phase one.** Clearing it between
# phases would delete the very thing under test.
#
# ## What is real here
#
# The bytes, the encryption, the spool on the device's own no-backup storage,
# the Keystore wrapping, the resumable HTTP session, the process death, the
# anonymous ciphertext download and the documents written into a granted tree.
#
# Set `RELAYIUM_RECOVERY_PROXY` to an origin that sits in front of the server —
# root's commit-drop proxy, which lets one PATCH commit server-side and then
# drops the response — to exercise the lost-answer path as well as the
# process-death one. Unset, the device talks to the server directly.
#
# It runs under BOTH maintained languages, each with its own backend, database
# and fixture account, for the reason `android-cloud-acceptance.sh` gives: the
# per-IP registration limiter is shared and a single-server run spends it.
#
# ## Credentials and links
#
# The fixture account is generated per run against a throwaway database. Its
# password reaches the device as an instrumentation argument and the server in a
# 0600 file, and neither is ever echoed. No report may contain `#k=`: a stored
# link carries its decryption key, and that is checked below rather than
# assumed.
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
test_class="com.relayium.android.CloudRecoveryAcceptanceTest"
out_dir="${RELAYIUM_RECOVERY_OUT:-$repo/apps/android/build/cloud-recovery-acceptance}"

# The phases, in the order they must run. Each is one instrumentation run; the
# force-stop happens between the first and the second.
phases=(
  stageAndInterruptAnUpload
  resumeTheInterruptedUploadInAFreshProcess
  theResumedObjectDecodesToTheOriginalBytes
  historyListsTheObjectAndDeletesItOnConfirmation
)

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

if [ -z "${RELAYIUM_RECOVERY_LOCALE:-}" ]; then
  say "== running one isolated child per maintained language =="
  child_failures=0
  for child_locale in en-US zh-CN; do
    say ""
    say "== $child_locale (its own backend, database and fixture account) =="
    if RELAYIUM_RECOVERY_LOCALE="$child_locale" "$0"; then
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
  say "== recoverable uploads passed under both maintained languages =="
  say "   instrumentation logs and reports under $out_dir"
  exit 0
fi

# ── from here down: ONE language, one disposable backend ────────────────────
locale="$RELAYIUM_RECOVERY_LOCALE"
case "$locale" in
  en-US) name=en ;;
  zh-CN) name=zh ;;
  *) say "ERROR: unsupported RELAYIUM_RECOVERY_LOCALE $locale"; exit 1 ;;
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
  || fail "the Android build failed; its log is $run_root/gradle.log"
app_apk="$repo/apps/android/app/build/outputs/apk/debug/app-debug.apk"
test_apk="$repo/apps/android/app/build/outputs/apk/androidTest/debug/app-debug-androidTest.apk"
[ -f "$app_apk" ] || fail "no debug APK at $app_apk"
[ -f "$test_apk" ] || fail "no instrumentation APK at $test_apk"

require_emulator

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
  kill -0 "$server_pid" 2>/dev/null || fail "the server exited; its log is $run_root/server.log"
  sleep 0.2
done
curl -sf --max-time 5 "$origin/api/config" >/dev/null 2>&1 \
  || fail "the server never became reachable"
assert_run_was_local

# ── the optional barrier in front of the server ─────────────────────────────
#
# The ports are chosen HERE, so a fixture cannot be told about them in advance.
# `RELAYIUM_RECOVERY_PROXY_CMD` is therefore started BY this script with the
# whole handshake already resolved in its environment:
#
#   RELAYIUM_UPSTREAM_ORIGIN       the real server, on loopback
#   RELAYIUM_PROXY_PORT            a free loopback port it MAY listen on
#   RELAYIUM_PROXY_PORT_FILE       where it writes the port it actually chose
#   RELAYIUM_PROXY_COMMITTED_FILE  it creates this once an upstream PATCH has
#                                  COMMITTED and its reply is being held
#   RELAYIUM_PROXY_RELEASE_FILE    this script creates it to release that reply
#
# That handshake is what makes the interruption deterministic rather than a
# race: the kill happens while the client is provably blocked awaiting the
# answer to bytes the server has already taken — the exact state a lost response
# leaves behind. Without a proxy the run still works and the process kill is
# still real, but the lost-answer path is not exercised, and that is said out
# loud rather than implied by a green run.
device_origin="$emulator_origin"
proxy_committed=""
proxy_release=""
if [ -n "${RELAYIUM_RECOVERY_PROXY_CMD:-}" ]; then
  proxy_port="$(free_port)"
  proxy_port_file="$run_root/proxy.port"
  proxy_committed="$run_root/proxy.committed"
  proxy_release="$run_root/proxy.release"
  say "== starting the barrier in front of the server =="
  RELAYIUM_UPSTREAM_ORIGIN="$origin" \
  RELAYIUM_PROXY_PORT="$proxy_port" \
  RELAYIUM_PROXY_PORT_FILE="$proxy_port_file" \
  RELAYIUM_PROXY_COMMITTED_FILE="$proxy_committed" \
  RELAYIUM_PROXY_RELEASE_FILE="$proxy_release" \
    ${RELAYIUM_RECOVERY_PROXY_CMD} >"$run_root/proxy.log" 2>&1 &
  proxy_pid=$!
  register_child proxy "$proxy_pid"
  # A proxy that chooses its own port says so; one that took the suggestion
  # simply never writes the file.
  for _ in $(seq 1 100); do
    [ -s "$proxy_port_file" ] && break
    kill -0 "$proxy_pid" 2>/dev/null \
      || fail "the barrier exited; its log is $run_root/proxy.log"
    sleep 0.1
  done
  if [ -s "$proxy_port_file" ]; then
    proxy_port="$(tr -dc '0-9' <"$proxy_port_file")"
  fi
  [ -n "$proxy_port" ] || fail "the barrier reported no port; its log is $run_root/proxy.log"
  for _ in $(seq 1 100); do
    curl -sf --max-time 5 "http://127.0.0.1:$proxy_port/api/config" >/dev/null 2>&1 && break
    kill -0 "$proxy_pid" 2>/dev/null \
      || fail "the barrier exited; its log is $run_root/proxy.log"
    sleep 0.2
  done
  curl -sf --max-time 5 "http://127.0.0.1:$proxy_port/api/config" >/dev/null 2>&1 \
    || fail "the barrier never became reachable; its log is $run_root/proxy.log"
  device_origin="http://10.0.2.2:$proxy_port"
  say "-- the device will talk to $device_origin, which fronts this run's server"
else
  say "-- no RELAYIUM_RECOVERY_PROXY_CMD: the process kill is the only interruption,"
  say "   so this run does not exercise a committed append whose answer was lost"
fi

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

# ONE clear, before the first phase. Clearing between phases would delete the
# staged upload this whole run exists to recover.
adbs shell pm clear "$app_id" >/dev/null 2>&1 || true
adbs shell setprop debug.relayium.backend "$device_origin" \
  || fail "could not point the app at $device_origin"
[ "$(adbs shell getprop debug.relayium.backend | tr -d '\r')" = "$device_origin" ] \
  || fail "the backend property did not take"
set_app_locale "$locale" >/dev/null

run_phase() {
  local method="$1"
  local log="$out_dir/instrument-$name-$method.log"
  say ""
  say "== $method under $locale =="
  set +e
  adbs shell am instrument -w -r \
    -e class "$test_class#$method" \
    -e relayium.origin "$device_origin" \
    -e relayium.email "$account_email" \
    -e relayium.password "$account_password" \
    "$test_pkg/$runner" >"$log" 2>&1
  local status=$?
  set -e
  # FOUR conditions, because "-1 alone" is also what a ZERO-test run reaches.
  local ran
  ran="$(grep -oE 'OK \([0-9]+ test' "$log" | grep -oE '[0-9]+' | tail -1 || true)"
  if [ "$status" -ne 0 ] \
     || ! grep -q '^INSTRUMENTATION_CODE: -1$' "$log" \
     || grep -qE '^INSTRUMENTATION_STATUS_CODE: (-1|-2)$' "$log" \
     || grep -q 'FAILURES!!!' "$log" \
     || [ "${ran:-0}" -lt 1 ]; then
    say "-- FAILED $method under $locale (adb exit $status, ran=${ran:-0}/1):"
    sed -n '/INSTRUMENTATION_STATUS: stack=/,/^INSTRUMENTATION_STATUS_CODE/p' "$log" | head -40 >&2
    restore_device
    fail "$test_class#$method failed under $locale"
  fi
  say "-- $method passed"
}

# ── phase 1, then the process death ─────────────────────────────────────────
#
# Phase one is NOT run with `run_phase`. It deliberately never returns: it
# starts a transfer and then holds the process alive, in flight, because an
# instrumentation run that finished would have closed the Activity — and closing
# it clears the ViewModel, which cancels the upload. A cancelled upload is not
# the thing under test. So it runs in the background, arms a marker once a
# server session exists and bytes are moving, and is KILLED here.
phase1_log="$out_dir/instrument-$name-${phases[0]}.log"
say ""
say "== ${phases[0]} under $locale (held open until the kill) =="
adbs shell am instrument -w -r \
  -e class "$test_class#${phases[0]}" \
  -e relayium.origin "$device_origin" \
  -e relayium.email "$account_email" \
  -e relayium.password "$account_password" \
  "$test_pkg/$runner" >"$phase1_log" 2>&1 &
phase1_pid=$!

# Wait for BOTH signals before killing anything.
#
#   the DEVICE's marker  — a session exists, the spool is on disk, bytes moved;
#   the BARRIER's marker — an upstream PATCH has committed and its reply is held,
#                          so the client is blocked awaiting an answer it will
#                          never get. That is the state a lost response leaves,
#                          and killing inside it is what makes this run
#                          deterministic rather than a race with the uplink.
#
# Without a barrier only the first is required, and the run says so above.
armed=0
for _ in $(seq 1 3000); do
  device_ready=0
  if adbs exec-out run-as "$app_id" cat "files/cloud-recovery-armed" 2>/dev/null \
       | grep -q '"armed"'; then
    device_ready=1
  fi
  barrier_ready=1
  if [ -n "$proxy_committed" ] && [ ! -e "$proxy_committed" ]; then
    barrier_ready=0
  fi
  if [ "$device_ready" -eq 1 ] && [ "$barrier_ready" -eq 1 ]; then
    armed=1
    break
  fi
  if ! kill -0 "$phase1_pid" 2>/dev/null; then
    say "-- ${phases[0]} exited before arming:"
    sed -n '/INSTRUMENTATION_STATUS: stack=/,/^INSTRUMENTATION_STATUS_CODE/p' "$phase1_log" \
      | head -40 >&2
    restore_device
    fail "phase one never reached an interruptible upload"
  fi
  sleep 0.2
done
[ "$armed" -eq 1 ] || { restore_device; fail "phase one never armed within its window"; }
say "-- armed: a session exists, the spool is on disk, and bytes are in flight"

# The process must be ALIVE at the moment it is killed, or this proves nothing.
# `|| true` INSIDE the substitution: `pidof` exits 1 when nothing matches, and
# under `set -e` with `pipefail` that would end the script before the check
# below ever ran — turning "the app was not running" into a silent abort rather
# than the explicit failure it has to be.
live_pids="$(adbs shell pidof "$app_id" 2>/dev/null | tr -d '\r' || true)"
[ -n "$live_pids" ] || { restore_device; fail "the app was not running when the kill was due"; }
say "-- the app is live as PID(s) $live_pids, mid-transfer"

say ""
say "== killing the app process =="
# The whole point of this script. Not a recreation and not a cancellation: the
# process is stopped mid-transfer, so no `finally`, no coroutine cleanup and no
# discard path gets to run. Everything the resume needs must already be on disk.
adbs shell am force-stop "$app_id" >/dev/null || fail "could not force-stop $app_id"
# Absence is the EXPECTED answer here, and `pidof` reports it by exiting 1 —
# which `set -e` plus `pipefail` would treat as the script failing. The `|| true`
# is inside each substitution so the emptiness checks are what decide.
for _ in $(seq 1 50); do
  pids="$(adbs shell pidof "$app_id" 2>/dev/null | tr -d '\r' || true)"
  [ -z "$pids" ] && break
  sleep 0.2
done
pids="$(adbs shell pidof "$app_id" 2>/dev/null | tr -d '\r' || true)"
[ -z "$pids" ] || fail "the app process is still alive after force-stop: $pids"
# The instrumentation went with it. A non-zero exit here is this phase's success
# condition, not its failure — which is precisely why it is not run through
# `run_phase`, whose checks would read the kill as a failed test.
wait "$phase1_pid" 2>/dev/null || true
# Released only AFTER the kill, so the held reply is dropped into a process that
# no longer exists — which is exactly the answer a resume must not depend on.
if [ -n "$proxy_release" ]; then
  : >"$proxy_release"
  say "-- the barrier's held reply was released into a dead process"
fi
say "-- the app process is gone; the staged upload is on the device and nothing else is"

# ── the remaining phases, each in a process that follows that death ─────────
for phase in "${phases[@]:1}"; do
  run_phase "$phase"
done

# ── the app's own observations ──────────────────────────────────────────────
#
# Read fail-CLOSED: `adb exec-out` carries the REMOTE `cat`'s diagnostic back on
# STDOUT, so a missing report would otherwise be saved as a file containing "No
# such file or directory" and called a pass.
for report in cloud-recovery-staged cloud-recovery-resumed cloud-recovery-decoded \
              cloud-recovery-history; do
  dest="$out_dir/$report-$name.json"
  adbs exec-out run-as "$app_id" cat "files/$report" >"$dest" 2>/dev/null \
    || fail "could not read the $report report off the device"
  [ -s "$dest" ] || fail "the $report report is empty; the phase did not write it"
  python3 -c 'import json,sys; json.load(open(sys.argv[1]))' "$dest" \
    || fail "the $report report is not JSON — it is almost certainly a device-side \
diagnostic that adb carried back on stdout"
done

# THE assertion this run exists for: what the server ended up holding decodes to
# exactly the bytes phase one staged, across a process death and a resume. A
# stream re-encrypted instead of replayed fails here and nowhere else.
python3 - "$out_dir/cloud-recovery-staged-$name.json" \
         "$out_dir/cloud-recovery-resumed-$name.json" \
         "$out_dir/cloud-recovery-decoded-$name.json" <<'PY' || fail "the resumed object is not the staged one"
import json, sys
staged, resumed, decoded = (json.load(open(p)) for p in sys.argv[1:4])
assert staged["staged"] is True, "phase one did not stage"
assert resumed["resumed"] is True, "phase two did not resume"
assert int(staged["sentBeforeInterruption"]) > 0, "nothing had been sent before the interruption"
assert int(staged["bytes"]) == int(decoded["bytes"]), (
    f"size differs: staged {staged['bytes']} vs decoded {decoded['bytes']}")
assert staged["digest"] == decoded["savedDigest"], (
    f"digest differs: staged {staged['digest']} vs decoded {decoded['savedDigest']}")

# Decoded plaintext alone does NOT prove a replay: a client that re-encrypted
# the user's files and re-uploaded them from zero would produce exactly the same
# plaintext at the far end. What distinguishes the two is the job's identity, so
# it is compared directly.
assert staged["jobId"] == resumed["jobId"], (
    "the resume ran against a different job than the one that was interrupted")
assert staged["spoolSha256"] == resumed["spoolSha256"], (
    "the staged ciphertext was re-created rather than replayed; a spool re-encrypted "
    "under the same key and frame sequence is exactly what must never happen")
assert staged["payloadTotal"] == resumed["payloadTotal"], "the payload total moved"
assert staged["uploadId"] == resumed["uploadId"], (
    "the resume replaced the server session instead of continuing it")
assert staged["finalizeAttempted"] is False, (
    "phase one recorded a finalize attempt, so the kill did not interrupt an upload")
print("-- the resumed object is byte-identical to the staged selection,")
print("   replayed from the same spool under the same session")
PY

python3 - "$out_dir/cloud-recovery-history-$name.json" <<'PY' || fail "the file list did not behave"
import json, sys
history = json.load(open(sys.argv[1]))
assert history["deleted"] is True, "the confirmed delete did not happen"
assert history["outcome"] == "DELETED", (
    f"a delete this device performed must be reported as such, not {history['outcome']}")
print("-- the file list listed the object and deleted it on confirmation")
PY

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
