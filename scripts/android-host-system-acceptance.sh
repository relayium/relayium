#!/usr/bin/env bash
#
# **The shared host's SYSTEM gates: a real other app, a real permission
# journey, and a real bounded picker lease.**
#
#   ./scripts/android-host-system-acceptance.sh
#
# `scripts/android-host-acceptance.sh` is the offline half — five destinations,
# staging, refusals, the scanner entry point — and it deliberately proves none
# of what is here. These three need something that process cannot produce:
#
#   * **A separate application.** `ExternalShareIngressTest` receives shares
#     from a private fixture APK running under its OWN uid, with its own
#     non-exported provider and its own grants. Admission refuses this app's own
#     provider by design, so a locally-built intent proves nothing about the
#     path a real share takes.
#   * **The operating system's permission UI.** `ScannerPermissionJourneyTest`
#     denies, retries, denies permanently, opens Settings, grants there by real
#     taps, and comes back. Nothing is injected: `grantRuntimePermission` would
#     make every one of those pass without touching the path a user walks.
#   * **Real elapsed time and a real peer.** `NearbyPickerLeaseWallClockTest`
#     establishes a Nearby session against the unchanged shipped
#     `LocalTransferPeer`, launches an owned document picker, presses Home from
#     inside it, and waits the shipped 120 seconds on the monotonic clock.
#
# ## What this owns, and what it must not change
#
# This script OWNS the Apple peer for the duration of the run: it builds the
# UNCHANGED `LocalTransferPeer`, starts it in its `local-link-peer` role, waits
# for `RELAYIUM_PEER_READY` and then for `resident` — the peer's own edge, set
# only once its Bonjour listener AND browser are up — reads the name it is
# actually advertising under, proves its control API refuses an unauthenticated
# caller, and tears it down through the shared child registry. All of that is
# the accepted `android-nearby-apple-acceptance.sh` path, reused rather than
# reimplemented; the peer binary and its role are untouched.
#
# Its only job here is to make the Nearby session real. Nothing is sent to it,
# because the point of the lease case is what happens to a session nobody is
# using.
#
# The sender APK is root's private fixture and is installed, not built, here.
#
# ## Values with spaces travel as HEX
#
# `adb shell am instrument` concatenates argv into ONE remote command line and
# the device shell re-splits it, so host-side quoting does not survive. A peer
# name really does contain spaces ("Relayium Apple Counterpart"). Same
# convention as `android-nearby-apple-acceptance.sh`, for the same reason.
set -Eeuo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$here/.." && pwd)"

# shellcheck source-path=SCRIPTDIR
# shellcheck source=lib/local-acceptance.sh
source "$here/lib/local-acceptance.sh"

adb="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-}}/platform-tools/adb"
serial="${ANDROID_SERIAL:-}"
gradle_bin="${RELAYIUM_GRADLE:-$repo/apps/android/gradlew}"
app_id="com.relayium.android.debug"
test_pkg="$app_id.test"
runner="androidx.test.runner.AndroidJUnitRunner"
sender_pkg="com.relayium.acceptance.sender"
out_dir="${RELAYIUM_HOST_SYSTEM_OUT:-$repo/apps/android/build/host-system-acceptance}"

# Root's private fixture APK. Installed, never built here: it is not product
# source and does not live in this repository.
sender_apk="${RELAYIUM_SENDER_APK:-}"

# Declared before anything can fail, because the cleanup below reads it. Under
# `set -u` an unbound expansion is fatal even inside `set +e`, so a run that
# died during the build — before the real value was captured — would abort its
# own cleanup on this line and leave the device as it found it mid-change.
orig_backend=""

# `say` and `fail` come from lib/local-acceptance.sh; redefining them here
# would fork the run's own reporting from the shared child registry's.
#
# Values with a space, a tab or a non-ASCII character travel as HEX: `adb shell`
# concatenates argv into ONE remote command line and the device shell re-splits
# it, so host-side quoting does not survive. A real advertised peer name has
# spaces. Same convention as android-nearby-apple-acceptance.sh.
hex_of() { printf '%s' "$1" | od -An -tx1 | tr -d ' \n'; }

acceptance_begin

# The peer and the app are both pointed at THIS run's disposable server. It is
# started even though a direct Bonjour link needs none: the peer takes an origin,
# the app asserts it resolved this one before anything else, and a run that
# silently fell back to production is the failure that assertion exists to catch.
# `--origin` is REQUIRED by the peer and validated by the product's own
# `AppEnvironment.loopbackTransferOrigin`, so it must be a real loopback origin.
# The local link contacts no server for its rendezvous; this exists so the peer
# can be constructed the way the product constructs it — and so the app can
# assert it resolved THIS run's origin rather than falling back to production.
say "== building the throwaway server =="
( cd "$repo/server" && go build -o "$run_root/relayium-server" . ) \
  >"$run_root/go-build.log" 2>&1 \
  || fail "the server did not build: $(tail -20 "$run_root/go-build.log")"
acceptance_start_server

# TWO origins, and they are not interchangeable.
#
# `$origin` is `127.0.0.1` and is what the Apple peer must be given: it runs on
# THIS machine, and its own loopback check refuses anything else. `10.0.2.2` is
# the emulator's alias for the host and is what the ANDROID side must be given —
# from inside the emulator, `127.0.0.1` is the emulator.
emulator_origin="http://10.0.2.2:$server_port"

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
    :app:assembleDebug :app:assembleDebugAndroidTest ) || fail "the build failed"

apk="$repo/apps/android/app/build/outputs/apk/debug/app-debug.apk"
test_apk="$repo/apps/android/app/build/outputs/apk/androidTest/debug/app-debug-androidTest.apk"
[ -f "$apk" ] || fail "no debug APK at $apk"
[ -f "$test_apk" ] || fail "no instrumentation APK at $test_apk"

say "== installing =="
adbs install -r "$apk" >/dev/null || fail "could not install the app"
adbs install -r "$test_apk" >/dev/null || fail "could not install the instrumentation"

# Captured BEFORE it is changed, and restored in cleanup. Leaving a dead
# throwaway origin set on the device would silently point the next run — or a
# person picking the emulator up — at a server that is gone.
orig_backend="$(adbs shell getprop debug.relayium.backend | tr -d '\r')"

adbs shell pm clear "$app_id" >/dev/null 2>&1 || true
adbs shell setprop debug.relayium.backend "$emulator_origin" \
  || fail "could not point the app at $emulator_origin"
[ "$(adbs shell getprop debug.relayium.backend | tr -d '\r')" = "$emulator_origin" ] \
  || fail "the backend property did not take"

# ── the permission state these gates start from ─────────────────────────────
#
# Revoked AND the user-set flags cleared, so the system still presents a dialog.
# `ScannerPermissionJourneyTest` asserts this rather than skipping: a run that
# started from a permanent refusal cannot make a first denial and must not
# report a pass for a journey it never took.
say "== revoking CAMERA and clearing its user flags =="
adbs shell pm revoke "$app_id" android.permission.CAMERA >/dev/null 2>&1 || true
adbs shell pm clear-permission-flags "$app_id" android.permission.CAMERA \
  user-set user-fixed >/dev/null 2>&1 || true

acceptance_extra_cleanup() {
  set +e
  # An empty original is restored as an EXPLICIT empty string: `adb shell`
  # rejoins argv into one remote command line, so a bare "" disappears and
  # `setprop` arrives with no value at all. The quotes are for the DEVICE's
  # shell, which is the one that re-splits.
  adbs shell "setprop debug.relayium.backend '$orig_backend'" >/dev/null 2>&1
  adbs shell pm revoke "$app_id" android.permission.CAMERA >/dev/null 2>&1
  adbs shell pm clear-permission-flags "$app_id" android.permission.CAMERA \
    user-set user-fixed >/dev/null 2>&1
  adbs shell am force-stop "$app_id" >/dev/null 2>&1
  set -e
}

failures=0

# ── 1. a real share from a real other application ───────────────────────────

run_class() {
  local name="$1" class="$2" expected="$3"
  shift 3
  local log="$out_dir/instrument-$name.log"
  say ""
  say "== $name =="
  set +e
  adbs shell am instrument -w -r -e class "$class" "$@" "$test_pkg/$runner" >"$log" 2>&1
  local status=$?
  set -e
  # The ORIGINAL exit is reported alongside the semantic verdict: `am instrument`
  # exits 0 almost unconditionally — including when the app crashed or nothing
  # ran — so the exit alone proves nothing, and dropping it would lose the one
  # signal that says adb itself failed.
  say "-- am instrument original exit: $status"
  if [ "$status" -ne 0 ] || ! "$here/lib/instrumentation-result.sh" "$log" "$expected"; then
    say "-- FAILED: $name (am instrument original exit $status)"
    # Bounded and consuming the whole file: `| head` would take SIGPIPE under
    # pipefail and end the script with 141, describing the printer instead of
    # the tests.
    awk '/INSTRUMENTATION_STATUS: stack=/,/^INSTRUMENTATION_STATUS_CODE/ {
           if (shown < 40) { print; shown++ }
         }' "$log" >&2 || true
    failures=$((failures + 1))
    return 1
  fi
  say "-- $name PASSED ($expected case(s))"
  return 0
}

if [ -n "$sender_apk" ]; then
  [ -f "$sender_apk" ] || fail "RELAYIUM_SENDER_APK=$sender_apk does not exist"
  say "== installing the private external-sender fixture =="
  adbs install -r "$sender_apk" >/dev/null || fail "could not install the sender fixture"
  installed="$(adbs shell pm list packages "$sender_pkg" | tr -d '\r')"
  [ -n "$installed" ] || fail "the sender fixture is not installed as $sender_pkg"
  # NINE cases; bump deliberately when one is added.
  run_class external-share com.relayium.android.integration.ExternalShareIngressTest 9 || true
else
  say "== SKIPPED: external-share gate (set RELAYIUM_SENDER_APK to the private fixture) =="
  say "-- this run does NOT cover real cross-uid shares"
  failures=$((failures + 1))
fi

# ── 2. the permission journey ──────────────────────────────────────────────

run_class permission-journey \
  com.relayium.android.integration.ScannerPermissionJourneyTest 1 || true

# ── 3. the bounded picker lease, against a real peer ───────────────────────
#
# The peer is OURS for this run. Its advertised name is read from its own
# control API rather than assumed, so a run that matched some other device on
# the link fails instead of passing.

say ""
say "== building the shipped LocalTransferPeer (unmodified) =="
peer_binary="${RELAYIUM_APPLE_PEER:-}"
if [ -z "$peer_binary" ]; then
  acceptance_set_swift_scratch
  ( cd "$repo/apps/RelayiumKit" && swift build ${swift_scratch+"${swift_scratch[@]}"} \
      --product LocalTransferPeer ) >"$run_root/swift-build.log" 2>&1 \
    || fail "the Apple peer did not build: $(tail -20 "$run_root/swift-build.log")"
  peer_binary="$(cd "$repo/apps/RelayiumKit" && swift build ${swift_scratch+"${swift_scratch[@]}"} \
      --product LocalTransferPeer --show-bin-path)/LocalTransferPeer"
fi
[ -x "$peer_binary" ] || fail "no Apple peer binary at $peer_binary"
say "-- peer binary: $peer_binary"

# Deliberately contains spaces, as real advertised names do; it travels to the
# instrumentation as hex for the reason `hex_of` gives.
peer_label="Relayium Host Lease Peer"
mkdir -p "$run_root/peer-receive"

# The control token goes in the ENVIRONMENT, never argv: argv on macOS is
# readable by every process this user runs.
peer_token="$(od -An -tx1 -N16 /dev/urandom | tr -d ' \n')"
RELAYIUM_ACCEPTANCE_CONTROL_TOKEN="$peer_token" \
  "$peer_binary" \
    --role local-link-peer \
    --origin "$origin" \
    --run-tag "$run_tag" \
    --receive-root "$run_root/peer-receive" \
    --name "$peer_label" \
    >"$run_root/host-lease-peer.log" 2>&1 &
peer_pid=$!
register_child host-lease-peer "$peer_pid"

peer_port=""
for _ in $(seq 1 100); do
  peer_port="$(sed -n 's/.*RELAYIUM_PEER_READY {"port":\([0-9]*\).*/\1/p' \
    "$run_root/host-lease-peer.log" | head -1)"
  [ -n "$peer_port" ] && break
  kill -0 "$peer_pid" 2>/dev/null \
    || fail "the peer exited: $(tail -20 "$run_root/host-lease-peer.log")"
  sleep 0.2
done
[ -n "$peer_port" ] || fail "the peer never printed RELAYIUM_PEER_READY"
say "-- peer control API on 127.0.0.1:$peer_port"

# An unauthenticated caller must be refused before the token is ever used.
assert_control_api_is_guarded "$peer_port"

peer_get() {
  curl -sf --max-time 10 -H "Authorization: Bearer $peer_token" \
    "http://127.0.0.1:$peer_port$1"
}
peer_post() {
  curl -sf --max-time 10 -X POST -H "Authorization: Bearer $peer_token" \
    "http://127.0.0.1:$peer_port$1" -d '{}'
}

peer_post /start >/dev/null || fail "the peer refused to start"

# `resident` is a real readiness edge: the peer sets it only once the Bonjour
# listener AND the browser are both up. Waiting for it means a host where the
# service never registered fails as THAT, rather than as an Android-side
# discovery timeout that blames the wrong end.
peer_name=""
for _ in $(seq 1 150); do
  status="$(peer_get /status || true)"
  case "$status" in
    *'"phase":"resident"'*)
      peer_name="$(printf '%s' "$status" \
        | python3 -c 'import json,sys; print(json.load(sys.stdin).get("peerName",""))')"
      break ;;
  esac
  kill -0 "$peer_pid" 2>/dev/null || fail "the peer exited before advertising"
  sleep 0.4
done
[ -n "$peer_name" ] \
  || fail "the peer never reached 'resident' — its Bonjour service did not come up"
say "-- the peer is advertising as '$peer_name'"

# Every non-hex extra must be whitespace-free or it splits on the device.
for literal in "$emulator_origin" "host-lease-fixture.bin"; do
  case "$literal" in
    *[[:space:]]*) fail "the extra '$literal' contains whitespace; it must travel as hex" ;;
  esac
done

run_class picker-lease \
  com.relayium.android.integration.NearbyPickerLeaseWallClockTest 1 \
  -e apple.peerNameHex "$(hex_of "$peer_name")" \
  -e apple.expectOrigin "$emulator_origin" \
  -e picker.fixtureName "host-lease-fixture.bin" || true

say ""
if [ "$failures" -ne 0 ]; then
  say "android-host-system-acceptance: FAILED or INCOMPLETE ($failures of 3 gates)"
  say "logs: $out_dir"
  exit 1
fi

say "android-host-system-acceptance: PASSED all 3 gates"
say "logs: $out_dir"
say ""
say "This run proves the three system gates named above. It does NOT cover the"
say "offline host matrix (scripts/android-host-acceptance.sh) or the live Device"
say "Inbox exchange, which has its own harness and its own owner."

# The shared cleanup treats a run that exits 0 without this as a failure, which
# is the right default: a script that returned early, or fell off the end past
# its own gates, must not be reported as a pass. Set on the LAST line and
# nowhere else, so it can only be reached by every gate above having passed.
completed=1
