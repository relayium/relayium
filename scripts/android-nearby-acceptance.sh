#!/usr/bin/env bash
#
# **Two real devices finding each other on a real network, with no code and —
# on the direct path — no server of any kind.**
#
#   ./scripts/android-nearby-acceptance.sh <host-serial> <guest-serial> [direct|hub]
#
# The cell nothing else in this repository fills. `app/src/test` drives the
# channel and the controller against scripted transports: precise about
# ordering, admission and ownership, and structurally unable to see whether
# `NsdManager` really registers this service on a real link, whether a peer
# resolves the TXT record this build writes, or whether WebRTC completes on host
# candidates alone with no ICE servers at all.
#
# So there is no double on either side:
#
#   * two real Android instances on a shared network, each running the real
#     debug APK through its OWN `MainActivity`/`TransferViewModel`;
#   * real `NsdManager` advertising and browsing — no address is passed to
#     either half, and a round that never LISTED the other device fails as the
#     discovery failure it is;
#   * real TCP signalling streams, real native WebRTC, the real SAF stack, and
#     the REAL system document picker, which stops the Activity every time;
#   * on the direct path, a loopback listener standing in for the backend, and
#     the round fails if a single connection reaches it.
#
# ## Isolation
#
# `scripts/lib/local-acceptance.sh` owns every rule: one per-run temp root kept
# on failure and removed on success, ephemeral ports, PID-exact cleanup with no
# `pkill`, and a `completed` flag so a run that stops early cannot report an
# unearned success. Device-side state this script changes — the backend
# property, the installed app — is restored through `acceptance_extra_cleanup`.
#
# **Neither mode can reach production.** The direct rounds point each build at a
# loopback port with nothing but a counter behind it. The hub rounds need a real
# server, so this run STARTS one: a throwaway loopback instance, reached from
# the devices as `10.0.2.2:<port>`. Clearing the override instead would resolve
# to `Backend.PRODUCTION`, which is how an acceptance ends up driving the real
# service; the instrumentation additionally compares its own resolved origin
# against the one this script says it set, and fails the round if they differ.
#
# ## What it proves
#
# Per round, in BOTH directions: the two devices reach one `link/1` session
# through an explicit selection on one side and an explicit consent on the
# other, derive the SAME six-digit SAS, exchange a message each way, and
# exchange a file each way whose bytes are compared by SHA-256 — by
# `scripts/test/android-nearby-oracle.py`, which re-derives every claim from
# what the two halves independently observed rather than trusting either.
#
# It also proves two things that are invisible until a user hits them: finishing
# a transfer returns to a LIVE device list rather than ending the room, and this
# app's own document picker does not end the session it was opened for.
#
# ## What a green run does NOT prove
#
# An end-to-end path check on emulator or developer hardware. Not a race
# detector, not physical-phone evidence, and not a claim about the Apple
# counterpart — that lane is separate, and a manually entered address is never a
# substitute for a Bonjour discovery.
set -Eeuo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$here/.." && pwd)"
# shellcheck source-path=SCRIPTDIR
# shellcheck source=lib/local-acceptance.sh
source "$here/lib/local-acceptance.sh"

[ $# -ge 2 ] || { say "usage: $0 <host-serial> <guest-serial> [direct|hub]"; exit 2; }
host_serial="$1"
guest_serial="$2"
mode="${3:-direct}"
case "$mode" in direct|hub) ;; *) say "mode must be direct or hub"; exit 2 ;; esac

gradle_bin="${RELAYIUM_GRADLE:-$repo/apps/android/gradlew}"
adb="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-}}/platform-tools/adb"

# The instrumentation lives in its OWN package. `com.relayium.android.debug` is
# the app; the runner is registered under `com.relayium.android.debug.test`, and
# naming the app package here produces "Unable to find instrumentation info" —
# which `am instrument` reports while exiting 0.
app_id="com.relayium.android.debug"
test_pkg="$app_id.test"
runner="androidx.test.runner.AndroidJUnitRunner"
test_class="com.relayium.android.nearby.NearbyLanAcceptanceTest#nearbyDirectDiscoveryAndTransfer"

# The fixture RULE, shared with the instrumentation, which generates the same
# bytes on the device from these two numbers. The payload never travels as an
# argument: `am instrument` arguments are re-split by the device shell into one
# remote command line, and a 300 KiB body as hex is 614 400 characters in a
# single argv entry — over the limit, and it surfaces as an unrelated `am` usage
# error rather than as anything about size.
host_seed=17
guest_seed=211
#   307_200  crosses the 192 KiB (196_608 B) logical fragment boundary
#         0  a zero-byte file, which has no CHUNK at all and completes on DONE
host_bytes=307200
guest_bytes=0
host_file="host-payload.bin"
guest_file="guest-payload.bin"

acceptance_begin

# Device-side state this run changed, restored whatever way the run ends.
# `acceptance_extra_cleanup` runs before the child processes are terminated and
# is never allowed to fail the cleanup it runs inside.
acceptance_extra_cleanup() {
  local serial
  for serial in "$host_serial" "$guest_serial"; do
    "$adb" -s "$serial" shell am force-stop "$app_id" >/dev/null 2>&1 || true
    "$adb" -s "$serial" shell setprop debug.relayium.backend '""' >/dev/null 2>&1 || true
  done
}

[ -x "$adb" ] || fail "no adb at $adb — set ANDROID_HOME or ANDROID_SDK_ROOT"
[ "$host_serial" != "$guest_serial" ] \
  || fail "the two serials are the same device; this run needs two"
for serial in "$host_serial" "$guest_serial"; do
  "$adb" -s "$serial" shell true >/dev/null 2>&1 \
    || fail "device $serial is not reachable through adb"
done

# ── the digests the oracle compares against, from the SAME rule ─────────────
digest_of() {
  python3 -c '
import hashlib, sys
seed, count = int(sys.argv[1]), int(sys.argv[2])
print(hashlib.sha256(bytes((i * 31 + seed) % 251 for i in range(count))).hexdigest())
' "$1" "$2"
}
host_sha="$(digest_of "$host_seed" "$host_bytes")"
guest_sha="$(digest_of "$guest_seed" "$guest_bytes")"
say "== fixtures: host $host_bytes bytes (seed $host_seed), guest $guest_bytes bytes (seed $guest_seed)"

# ── build once, install on both ────────────────────────────────────────────
say "== building the debug APK and its instrumentation =="
[ -x "$gradle_bin" ] || gradle_bin="gradle"
( cd "$repo/apps/android" && "$gradle_bin" -Prelayium.android=true \
    :app:assembleDebug :app:assembleDebugAndroidTest >"$run_root/gradle.log" 2>&1 ) \
  || fail "the Android build failed: $(tail -30 "$run_root/gradle.log")"
app_apk="$repo/apps/android/app/build/outputs/apk/debug/app-debug.apk"
test_apk="$repo/apps/android/app/build/outputs/apk/androidTest/debug/app-debug-androidTest.apk"
[ -f "$app_apk" ] || fail "no debug APK at $app_apk"
[ -f "$test_apk" ] || fail "no instrumentation APK at $test_apk"

for serial in "$host_serial" "$guest_serial"; do
  say "== installing on $serial =="
  "$adb" -s "$serial" install -r -t "$app_apk" >/dev/null \
    || fail "could not install the app on $serial"
  "$adb" -s "$serial" install -r -t "$test_apk" >/dev/null \
    || fail "could not install the instrumentation on $serial"
  # App data survives a reinstall, so a previous run's disposable tree would
  # otherwise still be there. Before `setprop`, never after: the override is a
  # system property and a clear does not touch it, but the ORDER is what keeps
  # that true if either ever changes.
  "$adb" -s "$serial" shell pm clear "$app_id" >/dev/null 2>&1 || true
done

# ── the origin each mode runs against; never production, in either ─────────
declare -a mode_args=()
trap_port=""
if [ "$mode" = "direct" ]; then
  # Nothing listens on the host for this: the listener is INSIDE the app
  # process, on the device's own loopback, and the round fails if it is ever
  # connected to. A fixed port because the property must be set before the app
  # process reads it.
  trap_port=18453
  expect_origin="http://127.0.0.1:$trap_port"
  mode_args=(-e nearby.trapPort "$trap_port")
  say "== direct mode: each build points at a loopback trap ($expect_origin)"
else
  # `acceptance_start_server` EXECUTES `$run_root/relayium-server`; it does not
  # build one. `acceptance_build` would, but it also builds the Swift
  # `LocalTransferPeer`, which this run has no second endpoint for — so the Go
  # half is built directly, exactly as `android-interop-acceptance.sh` does.
  # Without this the hub mode fails at "the server exited" with nothing to say
  # why, because there was never a binary.
  command -v go >/dev/null 2>&1 || fail "hub mode needs the Go toolchain to build the server"
  say "== building the throwaway server =="
  ( cd "$repo/server" && go build -o "$run_root/relayium-server" . ) \
    >"$run_root/go-build.log" 2>&1 \
    || fail "the server did not build: $(tail -20 "$run_root/go-build.log")"
  [ -x "$run_root/relayium-server" ] || fail "no server binary at $run_root/relayium-server"
  acceptance_start_server
  # The emulator reaches the host's loopback as 10.0.2.2. `Backend.resolve`
  # PARSES this and accepts only an exact local origin.
  expect_origin="http://10.0.2.2:$server_port"
  mode_args=(-e nearby.hub 1)
  say "== hub mode: a throwaway server at $origin, reached as $expect_origin"
fi

for serial in "$host_serial" "$guest_serial"; do
  "$adb" -s "$serial" shell setprop debug.relayium.backend "$expect_origin" \
    || fail "could not point $serial at $expect_origin"
  [ "$("$adb" -s "$serial" shell getprop debug.relayium.backend | tr -d '\r')" = "$expect_origin" ] \
    || fail "the backend property did not take on $serial"
done
say "-- both devices are pointed at $expect_origin"

# ── device names, read from the devices ────────────────────────────────────
#
# Two identical images report the SAME model, so a name is not an identifier
# here. When they differ, the name is passed and the round additionally proves
# the RIGHT device was chosen out of everything listed.
host_model="$("$adb" -s "$host_serial" shell getprop ro.product.model | tr -d '\r\n')"
guest_model="$("$adb" -s "$guest_serial" shell getprop ro.product.model | tr -d '\r\n')"
# Optional argument lists. EVERY expansion of these below uses the
# `${name+"${name[@]}"}` form, and it is not style: macOS ships Bash **3.2**,
# where `"${empty[@]}"` under `set -u` is an UNBOUND VARIABLE error rather than
# the empty expansion Bash 4.4+ produces. Two identical device models make these
# empty, which is the ordinary case for a two-emulator run — so the bare form
# fails exactly the configuration this script exists for. The same pattern is
# used by `lib/local-acceptance.sh` for `swift_scratch`, for the same reason.
declare -a host_peer_args=() guest_peer_args=()
if [ -n "$host_model" ] && [ "$host_model" != "$guest_model" ]; then
  host_peer_args=(-e nearby.peerName "$guest_model")
  guest_peer_args=(-e nearby.peerName "$host_model")
  say "-- the devices are distinguishable by name; the round proves the exact choice"
else
  say "-- identical device models: the round requires exactly one other device listed"
fi

# The REAL DocumentsUI round trip is the default. Opting out is explicit, and
# the report records which happened so the oracle can refuse a skipped one.
real_picker="${RELAYIUM_NEARBY_REAL_PICKER:-1}"

run_half() {
  local serial="$1" role="$2" log="$3"; shift 3
  "$adb" -s "$serial" shell am instrument -w -r \
    -e class "$test_class" \
    -e nearby.role "$role" \
    -e nearby.expectOrigin "$expect_origin" \
    -e nearby.realPicker "$real_picker" \
    "$@" \
    "$test_pkg/$runner" >"$log" 2>&1 &
  register_child "instrument-$role" $!
}

say "== running both halves ($mode, real picker=$real_picker) =="
run_half "$host_serial" host "$run_root/host.log" \
  -e nearby.payloadSeed "$host_seed" \
  -e nearby.payloadBytes "$host_bytes" \
  -e nearby.name "$host_file" \
  -e nearby.peerFile "$guest_file" \
  -e nearby.peerSha "$guest_sha" \
  -e nearby.message "from-host" \
  -e nearby.peerMessage "from-guest" \
  ${host_peer_args+"${host_peer_args[@]}"} ${mode_args+"${mode_args[@]}"}
host_pid="${child_pids[$((${#child_pids[@]} - 1))]}"

run_half "$guest_serial" guest "$run_root/guest.log" \
  -e nearby.payloadSeed "$guest_seed" \
  -e nearby.payloadBytes "$guest_bytes" \
  -e nearby.name "$guest_file" \
  -e nearby.peerFile "$host_file" \
  -e nearby.peerSha "$host_sha" \
  -e nearby.message "from-guest" \
  -e nearby.peerMessage "from-host" \
  ${guest_peer_args+"${guest_peer_args[@]}"} ${mode_args+"${mode_args[@]}"}
guest_pid="${child_pids[$((${#child_pids[@]} - 1))]}"

# ── the two-endpoint barrier ────────────────────────────────────────────────
#
# Neither half may tear its session down while the other is still asserting
# against it. The local message history is SESSION state, so a side that
# finished, disconnected and stopped Nearby emptied its counterpart's history
# mid-poll — and that counterpart failed for having succeeded slightly later,
# on a round whose bytes and text had all been verified.
#
# This launcher is the only process that can see both devices, so it is the only
# thing that can answer "are both done?". Each half writes its ready marker only
# after every assertion it owns has passed; both are released together. It is
# deliberately NOT a sleep, which would prove nothing about the other side, and
# deliberately not the transfer's own wire, which is the thing under test.
ready_on() {
  [ "$("$adb" -s "$1" exec-out run-as "$app_id" \
        sh -c "test -f files/$2 && echo yes" 2>/dev/null | tr -d '\r')" = "yes" ]
}

release_on() {
  "$adb" -s "$1" exec-out run-as "$app_id" \
    sh -c "printf go > files/$2" >/dev/null 2>&1
}

# One phase: wait for BOTH halves to declare it, then release both together.
# Always returns 0 — a barrier that gave up must let each half report what IT
# was waiting for, rather than becoming the failure itself.
run_barrier_phase() {
  local name="$1" ready="$2" release="$3" waited=0
  while [ "$waited" -lt "$barrier_timeout" ]; do
    # A half that has already exited will never write its marker; stop waiting
    # rather than holding the other one at the barrier for the full bound.
    if ! kill -0 "$host_pid" 2>/dev/null || ! kill -0 "$guest_pid" 2>/dev/null; then
      say "-- barrier[$name]: a half exited before both were ready; releasing so the"
      say "   survivor reports its own failure rather than the barrier's"
      release_on "$host_serial" "$release"; release_on "$guest_serial" "$release"
      return 0
    fi
    if ready_on "$host_serial" "$ready" && ready_on "$guest_serial" "$ready"; then
      say "-- barrier[$name]: both halves reached it; releasing together"
      release_on "$host_serial" "$release" && release_on "$guest_serial" "$release"
      return 0
    fi
    sleep 1
    waited=$((waited + 1))
  done
  say "-- barrier[$name]: timed out after ${barrier_timeout}s; releasing so each half"
  say "   reports what it was actually waiting for"
  release_on "$host_serial" "$release"; release_on "$guest_serial" "$release"
  return 0
}

# TWO phases, because there are two separate moments at which one endpoint's
# ordinary next step destroys something the other is still asserting against.
# `transfer` guards the session: the message history is session state, and a
# side that disconnects first empties its counterpart's mid-poll. `room` guards
# the ROSTER: stopping Nearby withdraws this device's advertisement, so the
# other half's peer correctly disappears from its list — which a hub round hit
# the moment the first barrier moved the race one phase later instead of
# removing it.
run_barriers() {
  run_barrier_phase transfer nearby-ready.json nearby-release
  run_barrier_phase room nearby-room-ready.json nearby-room-release
}

barrier_timeout=300
run_barriers &
register_child barrier $!

host_status=0; wait "$host_pid" || host_status=$?
guest_status=0; wait "$guest_pid" || guest_status=$?
say "-- original exits: host $host_status, guest $guest_status"

# `am instrument` exits 0 almost unconditionally — including when the process
# crashed and when the instrumentation could not be found — so the ORIGINAL exit
# is reported and the result is judged from the status stream.
[ "$host_status" = 0 ] || fail "the host's am instrument exited $host_status"
[ "$guest_status" = 0 ] || fail "the guest's am instrument exited $guest_status"
for name in host guest; do
  "$here/lib/instrumentation-result.sh" "$run_root/$name.log" 1 \
    || fail "the $name half did not run exactly one passing test (see $run_root/$name.log)"
done

for pair in "$host_serial:host" "$guest_serial:guest"; do
  serial="${pair%%:*}"; name="${pair##*:}"
  "$adb" -s "$serial" exec-out run-as "$app_id" cat files/nearby-report.json \
    >"$run_root/$name-report.json" 2>/dev/null \
    || fail "could not read the $name device's report"
done

python3 "$repo/scripts/test/android-nearby-oracle.py" \
  "$run_root/host-report.json" "$run_root/guest-report.json" \
  "$host_sha" "$guest_sha" "$mode" "$real_picker" \
  || fail "the round's own observations do not support a pass"

say ""
say "== Nearby ($mode): real discovery, explicit selection and consent, one link/1 session,"
say "   a matching SAS, a message and a file in each direction compared by SHA-256,"
say "   a room that survived the transfer, and — through the REAL DocumentsUI —"
say "   a session that survived its own picker =="
if [ "$mode" = "direct" ]; then
  say "   The direct rounds reached NO server: a loopback listener counted zero connections."
else
  say "   The hub rounds used this run's OWN throwaway server, never production."
fi
say "   NOT physical-phone evidence, and NOT a claim about the Apple counterpart."
completed=1
