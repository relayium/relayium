#!/usr/bin/env bash
#
# **The Android app and the UNCHANGED Apple client, finding each other over real
# Bonjour on one link.**
#
#   ./scripts/android-nearby-apple-acceptance.sh <emulator-serial>
#
# `android-nearby-acceptance.sh` puts two copies of the ANDROID implementation on
# one link, and two copies of one bug agree perfectly. This is the round where
# the discovery record this build writes is parsed by the shipped Apple parser,
# its framing is read by the Apple reader, and its `link/1` handshake is answered
# by the Apple link surface. A disagreement between two independently written
# clients is the only class of defect neither side's own tests can see.
#
# So there is no double on either side:
#
#   * the real Android debug APK on a real instance, through its own
#     `MainActivity`/`TransferViewModel`, driving the real Nearby surface and the
#     real system document picker;
#   * the real shipped `LocalTransferPeer` in its `local-link-peer` role, which
#     composes the product's own `LocalPeerAdvertisement`,
#     `LocalPeerSignalingChannel`, `NetworkLocalPeerTransport` and link surface.
#     Nothing in `apps/RelayiumKit` is modified by this run;
#   * real `NsdManager` on one side and real Bonjour on the other. NO address is
#     passed to the Android half at any point — it must FIND the Mac.
#
# ## One direction, and it says so
#
# `local-link-peer` finishes on an INBOUND batch and its `/drive` endpoint
# refuses that role, so it receives and does not send. This round is therefore
# **Android → Apple**. The reverse is a separate harness with its own launcher.
#
# ## What a green run does NOT prove
#
# A Mac running the shipped modules is not an iPhone. This is evidence about the
# Apple IMPLEMENTATION, not about Apple hardware, and it is never to be described
# as a physical-device result.
set -Eeuo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$here/.." && pwd)"
# shellcheck source-path=SCRIPTDIR
# shellcheck source=lib/local-acceptance.sh
source "$here/lib/local-acceptance.sh"

[ $# -ge 1 ] || { say "usage: $0 <emulator-serial>"; exit 2; }
serial="$1"

gradle_bin="${RELAYIUM_GRADLE:-$repo/apps/android/gradlew}"
adb="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-}}/platform-tools/adb"
app_id="com.relayium.android.debug"
test_pkg="$app_id.test"
runner="androidx.test.runner.AndroidJUnitRunner"
test_class="com.relayium.android.nearby.NearbyAppleCounterpartTest#sendsToTheAppleLocalLinkPeerOverBonjour"

# The fixture RULE, shared with the instrumentation, which generates the same
# bytes on the device. Never the bytes themselves: a body as hex is one argv
# entry past the device shell's limit.
payload_seed=41
payload_bytes=307200          # past the 192 KiB logical fragment boundary
payload_name="android-to-apple.bin"
# Deliberately contains spaces, and deliberately not "fixed" by removing them:
# real advertised device names do. See `hex_of` for how it travels.
peer_label="Relayium Apple Counterpart"
# Non-ASCII and whitespace-significant on purpose: the message rides an
# AEAD-sealed text frame, so anything that trims, normalises or re-encodes
# surfaces here rather than as a vague difference later.
android_message="$(printf '%b' "android → apple: 端到端 · nested 🌍\tindented   ")"

# `am instrument` arguments are re-split by the DEVICE shell — `adb shell`
# concatenates argv into ONE remote command line, and host-side quoting does not
# survive that — so every value with a space, a tab or a non-ASCII character
# travels as hex and the instrumentation decodes it. Getting this wrong does not
# look like a quoting bug: the extra splits and `am` reports an unrelated usage
# error, or worse, a later positional lands on the runner. This is the same
# convention `android-interop-acceptance.sh` uses, for the same reason.
hex_of() { printf '%s' "$1" | od -An -tx1 | tr -d ' \n'; }

acceptance_begin

acceptance_extra_cleanup() {
  "$adb" -s "$serial" shell am force-stop "$app_id" >/dev/null 2>&1 || true
  "$adb" -s "$serial" shell setprop debug.relayium.backend '""' >/dev/null 2>&1 || true
}

[ -x "$adb" ] || fail "no adb at $adb — set ANDROID_HOME or ANDROID_SDK_ROOT"
"$adb" -s "$serial" shell true >/dev/null 2>&1 || fail "device $serial is not reachable"
command -v go >/dev/null 2>&1 || fail "this run needs the Go toolchain for its throwaway server"
command -v swift >/dev/null 2>&1 || fail "this run needs a Swift toolchain for the Apple peer"

expected_sha="$(python3 -c '
import hashlib, sys
seed, count = int(sys.argv[1]), int(sys.argv[2])
print(hashlib.sha256(bytes((i * 31 + seed) % 251 for i in range(count))).hexdigest())
' "$payload_seed" "$payload_bytes")"
say "== fixture: $payload_bytes bytes (seed $payload_seed), sha256 ${expected_sha:0:12}…"

# ── the throwaway server ───────────────────────────────────────────────────
#
# `--origin` is REQUIRED by the peer and validated by the product's own
# `AppEnvironment.loopbackTransferOrigin`, so it must be a real loopback origin.
# The local link contacts no server for its rendezvous; this exists so the peer
# can be constructed the way the product constructs it.
say "== building the throwaway server =="
( cd "$repo/server" && go build -o "$run_root/relayium-server" . ) \
  >"$run_root/go-build.log" 2>&1 \
  || fail "the server did not build: $(tail -20 "$run_root/go-build.log")"
acceptance_start_server

# ── the UNCHANGED Apple peer ───────────────────────────────────────────────
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

mkdir -p "$run_root/apple-receive"
# The token goes in the ENVIRONMENT, never argv: argv on macOS is readable by
# every process this user runs. The peer requires it there.
peer_token="$(od -An -tx1 -N16 /dev/urandom | tr -d ' \n')"
RELAYIUM_ACCEPTANCE_CONTROL_TOKEN="$peer_token" \
  "$peer_binary" \
    --role local-link-peer \
    --origin "$origin" \
    --run-tag "$run_tag" \
    --receive-root "$run_root/apple-receive" \
    --name "$peer_label" \
    >"$run_root/apple-peer.log" 2>&1 &
peer_pid=$!
register_child apple-peer "$peer_pid"

peer_port=""
for _ in $(seq 1 100); do
  peer_port="$(sed -n 's/.*RELAYIUM_PEER_READY {"port":\([0-9]*\).*/\1/p' "$run_root/apple-peer.log" | head -1)"
  [ -n "$peer_port" ] && break
  kill -0 "$peer_pid" 2>/dev/null || fail "the Apple peer exited: $(tail -20 "$run_root/apple-peer.log")"
  sleep 0.2
done
[ -n "$peer_port" ] || fail "the Apple peer never printed RELAYIUM_PEER_READY"
say "-- Apple peer control API on 127.0.0.1:$peer_port"

peer_get() {
  curl -sf --max-time 10 -H "Authorization: Bearer $peer_token" \
    "http://127.0.0.1:$peer_port$1"
}
peer_post() {
  curl -sf --max-time 10 -X POST -H "Authorization: Bearer $peer_token" \
    "http://127.0.0.1:$peer_port$1" -d '{}'
}

peer_post /start >/dev/null || fail "the Apple peer refused to start"

# `resident` is a real readiness edge: the peer's lifecycle sets it only once
# the Bonjour listener AND the browser are both ready. Waiting for it means a
# host where the service never registered fails as THAT, rather than as an
# Android-side discovery timeout that blames the wrong end.
peer_name=""
for _ in $(seq 1 150); do
  status="$(peer_get /status || true)"
  case "$status" in
    *'"phase":"resident"'*)
      peer_name="$(printf '%s' "$status" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("peerName",""))')"
      break ;;
  esac
  kill -0 "$peer_pid" 2>/dev/null || fail "the Apple peer exited before advertising"
  sleep 0.4
done
[ -n "$peer_name" ] || fail "the Apple peer never reached 'resident' — its Bonjour service did not come up"
say "-- the Apple peer is advertising as '$peer_name'"

# ── the Android half ───────────────────────────────────────────────────────
say "== building and installing the debug app =="
[ -x "$gradle_bin" ] || gradle_bin="gradle"
( cd "$repo/apps/android" && "$gradle_bin" -Prelayium.android=true \
    :app:assembleDebug :app:assembleDebugAndroidTest >"$run_root/gradle.log" 2>&1 ) \
  || fail "the Android build failed: $(tail -30 "$run_root/gradle.log")"
app_apk="$repo/apps/android/app/build/outputs/apk/debug/app-debug.apk"
test_apk="$repo/apps/android/app/build/outputs/apk/androidTest/debug/app-debug-androidTest.apk"
"$adb" -s "$serial" install -r -t "$app_apk" >/dev/null || fail "could not install the app"
"$adb" -s "$serial" install -r -t "$test_apk" >/dev/null || fail "could not install the instrumentation"
"$adb" -s "$serial" shell pm clear "$app_id" >/dev/null 2>&1 || true

emulator_origin="http://10.0.2.2:$server_port"
"$adb" -s "$serial" shell setprop debug.relayium.backend "$emulator_origin" \
  || fail "could not point the app at $emulator_origin"
[ "$("$adb" -s "$serial" shell getprop debug.relayium.backend | tr -d '\r')" = "$emulator_origin" ] \
  || fail "the backend property did not take"

# Every extra that is NOT hex-encoded must be free of whitespace, or it splits
# on the device exactly as the two above would have. Checked rather than assumed:
# a fixture that grows a space later would otherwise fail as an `am` usage error.
for literal in "$payload_name" "$emulator_origin" "$test_class" "$payload_seed" "$payload_bytes"; do
  case "$literal" in
    *[[:space:]]*) fail "the extra '$literal' contains whitespace; it must travel as hex" ;;
  esac
done

# The expected message goes to the oracle through a FILE, not argv: it is
# non-ASCII and whitespace-significant, and a comparison value that had to
# survive two levels of quoting to be compared is not a reliable comparison.
printf '%s' "$android_message" >"$run_root/expected-message.txt"

say "== running the Android half =="
"$adb" -s "$serial" shell am instrument -w -r \
  -e class "$test_class" \
  -e apple.peerNameHex "$(hex_of "$peer_name")" \
  -e apple.name "$payload_name" \
  -e apple.payloadSeed "$payload_seed" \
  -e apple.payloadBytes "$payload_bytes" \
  -e apple.expectOrigin "$emulator_origin" \
  -e apple.messageHex "$(hex_of "$android_message")" \
  "$test_pkg/$runner" >"$run_root/android.log" 2>&1 &
android_pid=$!
register_child instrument-android "$android_pid"

# ── the barrier: read the Apple receipts BEFORE either side tears down ─────
release_when_ready() {
  local waited=0
  while [ "$waited" -lt 300 ]; do
    kill -0 "$android_pid" 2>/dev/null || break
    if [ "$("$adb" -s "$serial" exec-out run-as "$app_id" \
            sh -c 'test -f files/apple-ready.json && echo yes' 2>/dev/null | tr -d '\r')" = "yes" ]; then
      peer_get /result >"$run_root/apple-result.json" 2>/dev/null || true
      peer_get /observed >"$run_root/apple-observed.json" 2>/dev/null || true
      break
    fi
    sleep 1
    waited=$((waited + 1))
  done
  "$adb" -s "$serial" exec-out run-as "$app_id" \
    sh -c 'printf go > files/apple-release' >/dev/null 2>&1 || true
}
release_when_ready &
register_child barrier $!

android_status=0; wait "$android_pid" || android_status=$?
say "-- original exit: android instrumentation $android_status"
[ "$android_status" = 0 ] || fail "the Android instrumentation exited $android_status"
"$here/lib/instrumentation-result.sh" "$run_root/android.log" 1 \
  || fail "the Android half did not run exactly one passing test (see $run_root/android.log)"

"$adb" -s "$serial" exec-out run-as "$app_id" cat files/apple-report.json \
  >"$run_root/android-report.json" 2>/dev/null \
  || fail "could not read the Android report"

# The peer's own terminal receipt, read after the transfer rather than from the
# barrier snapshot, so one written late is still compared. `/observed` is NOT
# re-read here: the SAS belongs to the LIVE link, and the barrier snapshot is
# the one taken while it was up.
peer_get /result >"$run_root/apple-result.json" 2>/dev/null || true
[ -s "$run_root/apple-observed.json" ] \
  || fail "no Apple /observed snapshot was captured at the barrier; the SAS cannot be compared"

python3 "$repo/scripts/test/android-nearby-oracle.py" --counterpart apple \
  "$run_root/android-report.json" "$run_root/apple-result.json" \
  "$run_root/apple-observed.json" \
  "$expected_sha" "$payload_name" "$payload_bytes" \
  "$run_root/expected-message.txt" \
  || fail "the round's own observations do not support a pass"

peer_post /shutdown >/dev/null 2>&1 || true
"$adb" -s "$serial" shell am force-stop "$app_id" >/dev/null 2>&1 || true

say ""
say "== Android → Apple over REAL Bonjour: the Android build's discovery record read by"
say "   the shipped Apple parser, its framing by the Apple reader, its link/1 handshake"
say "   answered by the Apple link surface, and $payload_bytes bytes verified by SHA-256"
say "   in the Apple peer's OWN receipt =="
say "   ONE direction: local-link-peer receives and does not send."
say "   NOT physical-device evidence: this is a Mac running the shipped modules, not an iPhone."
completed=1
