#!/usr/bin/env bash
#
# **The Android app and the UNCHANGED Apple local-link modules, moving files and
# text in BOTH directions over one real Bonjour link.**
#
#   ./scripts/android-nearby-apple-bidirectional-acceptance.sh <emulator-serial> \
#       [--dial-side apple|android]
#
# ## The cell nothing else fills
#
# `scripts/android-nearby-apple-acceptance.sh` proves ONE direction, and says so:
# the counterpart it drives (`LocalTransferPeer --role local-link-peer`) finishes
# on an inbound batch and its `/drive` route refuses that role, so the Apple half
# receives and never sends. Until this run existed, nothing had ever seen the
# shipped Apple modules ORIGINATE a local-link transfer against a second
# implementation: not the manifest they announce, not the chunk stream they
# produce, not the sealed text frame they emit, and not this app's receive path
# reading any of it. That is the half of the product an iPhone user spends most
# of their time in.
#
# `scripts/android-nearby-acceptance.sh` puts two copies of the ANDROID
# implementation on one link, and two copies of one bug agree perfectly.
#
# ## What is real here, and what the Apple half actually is
#
#  * the real Android debug APK on a real instance, through its own
#    `MainActivity`/`TransferViewModel`, driving the real Nearby surface, the
#    real system file picker AND the real system folder picker;
#  * on the Mac, a fixture CALLER that composes the unchanged shipped
#    `LocalPeerAdvertisement`, `LocalPeerSignalingChannel`,
#    `NetworkLocalPeerTransport`, `LanDiscoveryModel`, `NearbyReceiveModel` and
#    `LinkWorkspaceModel` — the same factories, the same arguments and the same
#    order `LocalLinkPeerHost` uses. Nothing under `apps/RelayiumKit` is modified
#    by this run, and the one module this package cannot import as a product
#    (`RelayiumPeerKit`, a target by design) is mirrored VERBATIM and SHA-256
#    checked file by file before it compiles;
#  * real `NsdManager` on one side and real Bonjour on the other. NO address is
#    passed to the Android half at any point — it must FIND the Mac, by the name
#    and the advertisement identity the Mac minted for this run.
#
# **Read the Apple half precisely.** It is the shipped Swift modules compiled
# from this repository, running on the host as a macOS process. It is NOT an iOS
# binary, not the iOS app, and NOT a device. A Mac running shipped modules is not
# an iPhone, and a green run here must never be described as physical-device
# evidence.
#
# ## Which side dials, and why it is a flag
#
# `--dial-side apple` (the default) has the MAC press Connect, so this round also
# covers an inbound link the Android side did not ask for — the assignment the
# one-way round has never taken. Bonjour's two halves fail separately: a host
# that can SEE an instance's advertisement has not thereby shown it can open a
# stream to the address behind it. `--dial-side android` is the documented
# fallback for a host where it cannot; the reverse DATA direction, which is what
# this acceptance exists for, is delivered either way, and the oracle asserts
# which assignment the run actually took rather than letting the two look alike.
#
# `scripts/fixtures/android-nearby-apple` also builds a `dial-probe` role that
# answers that question in about half a minute instead of a whole round. See
# `docs/android-nearby-apple-acceptance.md`.
#
# ## Evidence
#
# On failure the run root is kept, and every report is in it. On SUCCESS the run
# root is removed by the shared cleanup, so set
# `RELAYIUM_APPLE_BIDI_ARTIFACTS=<dir>` to keep the reports, the logs and the
# mirrored-module hashes: a passing round whose evidence was deleted cannot be
# audited afterwards.
set -Eeuo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$here/.." && pwd)"
# shellcheck source-path=SCRIPTDIR
# shellcheck source=lib/local-acceptance.sh
source "$here/lib/local-acceptance.sh"

[ $# -ge 1 ] || { say "usage: $0 <emulator-serial> [--dial-side apple|android]"; exit 2; }
serial="$1"
shift
dial_side="apple"
while [ $# -gt 0 ]; do
  case "$1" in
    --dial-side)
      [ $# -ge 2 ] || { say "--dial-side needs a value"; exit 2; }
      dial_side="$2"
      shift 2
      ;;
    *) say "unknown argument: $1"; exit 2 ;;
  esac
done
case "$dial_side" in
  apple|android) ;;
  *) say "--dial-side must be apple or android"; exit 2 ;;
esac

gradle_bin="${RELAYIUM_GRADLE:-$repo/apps/android/gradlew}"
adb="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-}}/platform-tools/adb"
app_id="com.relayium.android.debug"
test_pkg="$app_id.test"
runner="androidx.test.runner.AndroidJUnitRunner"
test_class="com.relayium.android.nearby.NearbyAppleBidirectionalTest#exchangesFilesAndTextWithTheAppleLocalLinkPeer"

# The name the Mac advertises. Deliberately contains spaces, and deliberately
# not "fixed" by removing them: real advertised device names do, and `hex_of`
# is how it survives `adb shell`.
apple_label="Relayium Apple Bidirectional"

# Non-ASCII and whitespace-significant on purpose, in BOTH directions: the
# bodies ride AEAD-sealed text frames, so anything that trims, normalises or
# re-encodes surfaces here rather than as a vague difference later.
android_message="$(printf '%b' "android \342\206\222 apple: \347\253\257\345\210\260\347\253\257 \302\267 nested \360\237\214\215\tindented   ")"
apple_message="$(printf '%b' "apple \342\206\222 android: \351\200\206\345\220\221 \302\267 reverse \360\237\215\216\ttabbed   ")"

# `am instrument` arguments are re-split by the DEVICE shell — `adb shell`
# concatenates argv into ONE remote command line, and host-side quoting does not
# survive that — so every value with a space, a tab or a non-ASCII character
# travels as hex and the instrumentation decodes it. Getting this wrong does not
# look like a quoting bug: the extra splits and `am` reports an unrelated usage
# error, or worse, a later positional lands on the runner.
hex_of() { printf '%s' "$1" | od -An -tx1 | tr -d ' \n'; }

artifacts="${RELAYIUM_APPLE_BIDI_ARTIFACTS:-}"

acceptance_begin

# On SUCCESS the shared cleanup removes the run root, so anything the owner
# needs afterwards has to be copied out first. Called from the extra-cleanup
# hook as well, so an interrupted run keeps whatever it had reached.
preserve_evidence() {
  [ -n "$artifacts" ] || return 0
  mkdir -p "$artifacts" 2>/dev/null || return 0
  local name
  for name in expectations.json android-report.json android-partial-report.json \
              android-partial-report.rejected apple-result.json \
              apple-observed.json apple-status.json outgoing-plan.json plan.json \
              expected-android-message.txt expected-apple-message.txt \
              apple-fixture.log apple-fixture.out android.log swift-build.log \
              gradle.log go-build.log module-hashes.txt; do
    [ -e "$run_root/$name" ] && cp "$run_root/$name" "$artifacts/$name" 2>/dev/null || true
  done
  return 0
}

# ── the one device setting this run mutates, and how it is put back ─────────
#
# `debug.relayium.backend` is not this run's property. It is the device's, and
# `Backend.readDebugOverride` fails CLOSED to the real service — so
# `setprop … ""` does not mean "leave it as it was", it means "point this
# device at PRODUCTION on its next launch". Three separate things therefore
# have to be true before anything is written back:
#
#   1. **this run must have captured the old value.** A failure in the
#      preflight, the fixture generation or either build happens BEFORE the
#      capture, and a cleanup that restored an empty default there would clear a
#      property this run never touched;
#   2. **this run must have overwritten it.** Capturing is not changing;
#   3. **the old value must be REPRESENTABLE as one remote shell token.**
#      `adb shell` re-joins argv into a single remote command line, so a value
#      containing a space, a quote or a `;` splits there — or executes. It is
#      quoted with `shlex.quote` and the quoting is PROVEN against the device
#      before the property is mutated at all; an unrepresentable value stops
#      the run with the property still holding it.
#
# The value travels as HEX between every step, because the whole point is that
# nothing trims or re-splits it. Only the single `\n` that `getprop` itself
# terminates its output with is removed.
backend_property_hex=""
backend_property_quoted=""
backend_property_captured=0
backend_property_changed=0

# `exec-out`, not `shell`: a pty would translate the bytes on the way back, and
# a value this run has to reproduce exactly cannot be read through a translator.
device_backend_property_hex() {
  "$adb" -s "$serial" exec-out sh -c 'getprop debug.relayium.backend' \
    | python3 -c 'import sys
raw = sys.stdin.buffer.read()
# EXACTLY the terminator getprop adds, and nothing else: trailing whitespace
# inside the value is part of the value.
if raw.endswith(b"\n"):
    raw = raw[:-1]
sys.stdout.write(raw.hex())'
}

# One POSIX token the device shell will parse back to exactly these bytes.
quote_for_device() {
  printf '%s' "$1" | python3 -c 'import shlex, sys
value = bytes.fromhex(sys.stdin.read()).decode("utf-8", "surrogateescape")
sys.stdout.write(shlex.quote(value))'
}

# **The Android half's report, on a path where the round did not read it.**
#
# Best effort by construction: it must never be able to fail the cleanup it runs
# inside, and it is not evidence of a pass — the oracle is never handed this
# file. What it is for is the failure the first live round had, where the only
# account of what the phone observed was inside an app about to be force-stopped.
#
# **Bounded by what exists.** The instrumentation writes its report from its own
# `finally`, so this recovers a round where the PHONE reported first — it timed
# out, failed and wrote — and recovers nothing where the Mac failed first and
# the test is still mid-method. That is not a gap to widen: in the second case
# the Mac's own named failure and `android.log` are the account, and waiting out
# the phone's remaining bound on every failure path would cost more than it
# tells.
#
# GRAMMAR-validated, and that is the part worth stating: `run-as` prints its own
# refusals on stdout and `adb` puts "device offline" there too, so an unchecked
# capture preserves an ERROR MESSAGE under a name that reads like the device's
# own report. A document that does not parse is kept under `.rejected` instead,
# so the failure is visible rather than silently absent.
pull_android_partial_report() {
  [ -x "$adb" ] || return 0
  # Nothing to recover when the round already read the real one.
  [ -s "$run_root/android-report.json" ] && return 0
  local raw="$run_root/android-partial-report.raw"
  "$adb" -s "$serial" exec-out run-as "$app_id" \
    cat files/apple-bidi-report.json >"$raw" 2>/dev/null || true
  if [ ! -s "$raw" ]; then
    rm -f "$raw"
    return 0
  fi
  if python3 -c 'import json,sys; json.load(open(sys.argv[1]))' "$raw" >/dev/null 2>&1; then
    mv "$raw" "$run_root/android-partial-report.json" 2>/dev/null || true
    say "-- recovered the Android half's partial report"
  else
    mv "$raw" "$run_root/android-partial-report.rejected" 2>/dev/null || true
    say "-- what the device returned for its report is not JSON; kept as .rejected"
  fi
  return 0
}

acceptance_extra_cleanup() {
  # BEFORE `preserve_evidence`, so the recovered document is copied out with
  # everything else, and before the force-stop below for the same reason the
  # barrier exists: the app is the only thing holding it.
  pull_android_partial_report
  preserve_evidence
  # Force-stop FIRST: a running app has already resolved its origin, and a
  # property changed under it would be neither the value it is using nor the
  # value the next launch reads.
  "$adb" -s "$serial" shell am force-stop "$app_id" >/dev/null 2>&1 || true
  # `:-` on both flags: `set -u` must not let the cleanup itself become the
  # error on a failure that happened before either was assigned.
  if [ "${backend_property_captured:-0}" != 1 ] || [ "${backend_property_changed:-0}" != 1 ]; then
    return 0
  fi
  if [ -n "$backend_property_hex" ]; then
    "$adb" -s "$serial" shell \
      "setprop debug.relayium.backend $backend_property_quoted" >/dev/null 2>&1 || true
  else
    # It was genuinely unset before this run, and this is how it goes back to
    # unset. Not a default — the observed previous state.
    "$adb" -s "$serial" shell "setprop debug.relayium.backend ''" >/dev/null 2>&1 || true
  fi
}

[ -x "$adb" ] || fail "no adb at $adb — set ANDROID_HOME or ANDROID_SDK_ROOT"
"$adb" -s "$serial" shell true >/dev/null 2>&1 || fail "device $serial is not reachable"
command -v go >/dev/null 2>&1 || fail "this run needs the Go toolchain for its throwaway server"
command -v swift >/dev/null 2>&1 || fail "this run needs a Swift toolchain for the Apple fixture"
command -v python3 >/dev/null 2>&1 || fail "this run needs python3 for its fixtures and its oracle"
if [ -n "$artifacts" ]; then
  mkdir -p "$artifacts" || fail "RELAYIUM_APPLE_BIDI_ARTIFACTS is not creatable: $artifacts"
fi

# The name the Android half will advertise under, derived the way the app
# derives it: `TransferViewModel` reads `android.os.Build.MODEL` once and
# `LocalPeerAdvertisement.sanitizeName` trims it. Read rather than assumed, so a
# device whose model differs fails as "no device by that name" instead of
# matching whatever else is on the link.
android_name="$("$adb" -s "$serial" shell getprop ro.product.model | tr -d '\r' \
  | sed 's/^[[:space:]]*//; s/[[:space:]]*$//')"
[ -n "$android_name" ] || fail "the device reports no ro.product.model, so it has no name to find"
say "== the Android half will advertise as '$android_name'"

# ── the fixtures, generated once, from a rule both sides share ──────────────
#
# The PAYLOADS are generated here and their digests computed here, because the
# launcher is the only party that is neither sender nor receiver: a digest
# supplied by whoever sent the bytes answers the question the receiver's receipt
# is the only honest answer to. Each side derives its own outgoing bytes from
# the SAME seed rule, so nothing about a fixture is asserted from one side only.
#
# The three shapes are deliberate and each has failed something before: a file
# past the 192 KiB logical fragment boundary, a ZERO-byte file (which every
# length-based check passes trivially), and a nested Unicode path (which a
# receiver that flattened a tree would satisfy on names alone).
mkdir -p "$run_root/apple-send" "$run_root/apple-receive"
python3 - "$run_root" "$dial_side" <<'FIXTURES' || fail "the fixtures could not be generated"
import hashlib, json, os, sys

root, dial_side = sys.argv[1], sys.argv[2]

def payload(seed, count):
    return bytes((i * 31 + seed) % 251 for i in range(count))

# Apple -> Android. Only this direction can carry a nested `path`: Android's own
# Nearby send surface is ActivityResultContracts.OpenMultipleDocuments — files,
# never a folder — so the app cannot originate one. A product fact, recorded
# here so the asymmetry is deliberate rather than forgotten.
apple_to_android = [
    {"name": "apple-large.bin", "path": None, "seed": 53, "size": 307200},
    {"name": "apple-empty.bin", "path": None, "seed": 11, "size": 0},
    {"name": "苹果 端到端 \U0001f30d.bin",
     "path": "苹果 嵌套/深 层/"
             "苹果 端到端 \U0001f30d.bin",
     "seed": 131, "size": 4096},
]
android_to_apple = [
    {"name": "android-large.bin", "path": None, "seed": 41, "size": 307200},
    {"name": "android-empty.bin", "path": None, "seed": 7, "size": 0},
    {"name": "安卓 端到端 \U0001f30d.bin",
     "path": None, "seed": 97, "size": 2048},
]

# The bytes the Mac will send, staged on disk so the fixture reads them through
# the product's own `FileURLSource`, which pins a descriptor.
send_root = os.path.join(root, "apple-send")
plan = {"files": [], "message": ""}
expect_apple_to_android = []
for index, entry in enumerate(apple_to_android):
    body = payload(entry["seed"], entry["size"])
    # Indexed rather than named: the staged basename is irrelevant (the manifest
    # name is passed explicitly) and a Unicode filename on the host filesystem
    # is one more thing between the fixture and the bytes it means to send.
    source = os.path.join(send_root, "%d.bin" % index)
    with open(source, "wb") as handle:
        handle.write(body)
    plan["files"].append({"name": entry["name"], "path": entry["path"], "source": source})
    expect_apple_to_android.append({
        "name": entry["name"], "path": entry["path"],
        "size": entry["size"], "sha256": hashlib.sha256(body).hexdigest(),
    })

expect_android_to_apple = []
outgoing = {"files": []}
for entry in android_to_apple:
    body = payload(entry["seed"], entry["size"])
    outgoing["files"].append({"name": entry["name"], "seed": entry["seed"],
                              "size": entry["size"]})
    expect_android_to_apple.append({
        # A flat batch lands straight in the chosen directory, so the receiving
        # side reports no `path`. Asserted as None rather than omitted: a
        # receiver that invented one would otherwise pass.
        "name": entry["name"], "path": None,
        "size": entry["size"], "sha256": hashlib.sha256(body).hexdigest(),
    })

def write(name, value):
    with open(os.path.join(root, name), "w", encoding="utf-8") as handle:
        json.dump(value, handle, ensure_ascii=True, sort_keys=True)

write("plan.json", plan)
write("outgoing-plan.json", outgoing)
write("expectations-partial.json", {
    "dialSide": dial_side,
    "appleToAndroid": expect_apple_to_android,
    "androidToApple": expect_android_to_apple,
})
print("fixtures: %d Apple->Android, %d Android->Apple"
      % (len(apple_to_android), len(android_to_apple)), file=sys.stderr)
FIXTURES

# The two message bodies go to the fixture and the oracle through FILES, never
# argv: both are non-ASCII and whitespace-significant, and a comparison value
# that had to survive two levels of shell quoting is not a reliable comparison.
printf '%s' "$android_message" >"$run_root/expected-android-message.txt"
printf '%s' "$apple_message" >"$run_root/expected-apple-message.txt"
python3 - "$run_root" "$run_root/expected-apple-message.txt" <<'PLANMSG' \
  || fail "the Mac's plan could not be completed"
import json, sys
root, message_path = sys.argv[1], sys.argv[2]
with open(root + "/plan.json", encoding="utf-8") as handle:
    plan = json.load(handle)
with open(message_path, encoding="utf-8") as handle:
    plan["message"] = handle.read()
with open(root + "/plan.json", "w", encoding="utf-8") as handle:
    json.dump(plan, handle, ensure_ascii=True, sort_keys=True)
PLANMSG

# ── the throwaway server ────────────────────────────────────────────────────
#
# `--origin` is REQUIRED by the fixture and validated by the product's own
# `AppEnvironment.loopbackTransferOrigin`, so it must be a real loopback origin.
# The local link contacts no server for its rendezvous; this exists so the peer
# is constructed the way the product constructs it, and so the Android half has
# a non-production origin to be pointed at.
say "== building the throwaway server =="
( cd "$repo/server" && go build -o "$run_root/relayium-server" . ) \
  >"$run_root/go-build.log" 2>&1 \
  || fail "the server did not build: $(tail -20 "$run_root/go-build.log")"
acceptance_start_server

# ── the Android half, built and installed BEFORE the Mac peer starts ────────
#
# The order matters. The fixture's watchdog measures from its last observed
# progress, and a Gradle build plus two installs between "advertising" and the
# first roster change is a long silence it would have to be told to ignore.
# Doing the slow work first removes the silence instead of widening the bound.
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

# Read BEFORE anything is written, and only then is a restore owed at all.
backend_property_hex="$(device_backend_property_hex)" \
  || fail "could not read this device's current debug.relayium.backend"
backend_property_captured=1
if [ -n "$backend_property_hex" ]; then
  backend_property_quoted="$(quote_for_device "$backend_property_hex")"
  # The quoting is PROVEN against this device's own shell before the property is
  # touched. A value that does not come back byte-for-byte is one this run
  # cannot put back, so it is not overwritten in the first place — an `adb
  # shell` argv re-join would otherwise split it, or run part of it.
  echoed_hex="$("$adb" -s "$serial" exec-out sh -c \
    "printf %s $backend_property_quoted" | od -An -tx1 | tr -d ' \n')" \
    || fail "could not verify that this device's backend override can be restored"
  [ "$echoed_hex" = "$backend_property_hex" ] \
    || fail "this device's debug.relayium.backend cannot be represented as one remote shell
   token, so this run will not overwrite a value it could not put back. It is
   unchanged. Clear or simplify it by hand and run again"
  # An `if`, not `[ … ] && say …`: as a top-level `&&` list a false test returns
  # 1 and `set -e` would end the run — silently, on the ordinary case. The
  # shared library records the same trap in `assert_run_was_local`.
  say "-- this device already has debug.relayium.backend set; it will be restored on the way out"
fi

"$adb" -s "$serial" shell setprop debug.relayium.backend "$emulator_origin" \
  || fail "could not point the app at $emulator_origin"
backend_property_changed=1
[ "$("$adb" -s "$serial" shell getprop debug.relayium.backend | tr -d '\r')" = "$emulator_origin" ] \
  || fail "the backend property did not take"

# ── the Apple fixture, from unchanged shipped modules ───────────────────────
say "== building the Apple fixture (unchanged shipped modules, verified) =="
acceptance_set_swift_scratch
fixture_root="$run_root/apple-fixture"
"$repo/scripts/fixtures/android-nearby-apple/prepare.sh" "$repo" "$fixture_root" \
  >"$run_root/prepare.log" 2>&1 \
  || fail "the fixture package could not be prepared: $(tail -20 "$run_root/prepare.log")"
cp "$fixture_root/module-hashes.txt" "$run_root/module-hashes.txt"
say "-- mirrored modules are byte-identical to the shipped ones (shasum -a 256 verified)"
( cd "$fixture_root" && RELAYIUM_KIT_PACKAGE_PATH="$repo/apps/RelayiumKit" \
    swift build ${swift_scratch+"${swift_scratch[@]}"} \
      --product AppleNearbyBidirectionalPeer ) >"$run_root/swift-build.log" 2>&1 \
  || fail "the Apple fixture did not build: $(tail -30 "$run_root/swift-build.log")"
peer_binary="$(cd "$fixture_root" && RELAYIUM_KIT_PACKAGE_PATH="$repo/apps/RelayiumKit" \
  swift build ${swift_scratch+"${swift_scratch[@]}"} \
    --product AppleNearbyBidirectionalPeer --show-bin-path)/AppleNearbyBidirectionalPeer"
[ -x "$peer_binary" ] || fail "no Apple fixture binary at $peer_binary"
say "-- fixture binary: $peer_binary"

# `start_peer` passes `--role --origin --run-tag`, registers the PID for the
# exact-PID cleanup, and parses the one RELAYIUM_PEER_READY line. The control
# bearer is already exported by `acceptance_start_server`; it never reaches argv.
start_peer apple-fixture local-link-bidirectional \
  --receive-root "$run_root/apple-receive" \
  --name "$apple_label" \
  --target-name "$android_name" \
  --plan "$run_root/plan.json" \
  --dial-side "$dial_side" \
  --expect-inbound-batches 3
apple_port="$peer_port"
apple_pid="$peer_pid"
assert_control_api_is_guarded "$apple_port"

# ── the two helpers every wait below is built from ──────────────────────────
#
# Both are CONDITIONS with a bound, never a sleep: a fixed sleep proves nothing
# about what the other side did, and an unbounded wait turns a diagnosable
# failure into a hang.
apple_status() { control "$apple_port" GET /status; }

apple_fail_if_failed() {
  local status="$1"
  case "$status" in
    *'"phase":"failed"'*)
      fail "the Apple fixture failed: $(json_field "$status" failure)"
      ;;
  esac
}

# A fact that OUTLIVES the phase that first published it, which is why this is
# keyed on the detail rather than on `phase == discovered`: with
# `--dial-side android` the Android half dials the instant it has verified the
# Mac, so this side can be past `discovered` before the launcher ever looks.
# The Android half is a child too, and a wait that watched only the Mac spent
# its whole bound after the instrumentation had already reported a failure —
# which is how the first live round took 361s to say something it knew at 122s.
# `${android_pid:-}` because the early waits run before it exists.
android_still_running() {
  [ -n "${android_pid:-}" ] || return 0
  kill -0 "$android_pid" 2>/dev/null
}

wait_for_apple_detail() {
  local key="$1" limit="$2" waited=0 status="" value=""
  while [ "$waited" -lt "$limit" ]; do
    status="$(apple_status || true)"
    apple_fail_if_failed "$status"
    value="$(json_field "$status" "$key")"
    [ -n "$value" ] && { printf '%s' "$value"; return 0; }
    kill -0 "$apple_pid" 2>/dev/null || fail "the Apple fixture exited before publishing '$key'"
    android_still_running \
      || fail "the Android instrumentation exited while waiting for '$key'; see $run_root/android.log"
    sleep 1
    waited=$((waited + 1))
  done
  fail "the Apple fixture never published '$key' in ${limit}s (phase $(json_field "$status" phase))"
}

wait_for_apple_phase() {
  local wanted="$1" limit="$2" waited=0 status=""
  while [ "$waited" -lt "$limit" ]; do
    status="$(apple_status || true)"
    apple_fail_if_failed "$status"
    [ "$(json_field "$status" phase)" = "$wanted" ] && return 0
    kill -0 "$apple_pid" 2>/dev/null || fail "the Apple fixture exited before reaching '$wanted'"
    android_still_running \
      || fail "the Android instrumentation exited while waiting for phase '$wanted'; see $run_root/android.log"
    sleep 1
    waited=$((waited + 1))
  done
  fail "the Apple fixture never reached '$wanted' in ${limit}s (phase $(json_field "$status" phase))"
}

# A marker the instrumentation wrote into the app's OWN files directory, read
# back with `run-as`. Out of band on purpose: the transfer's own wire is the
# thing under test and cannot be its own completion oracle.
wait_for_device_marker() {
  local marker="$1" limit="$2" waited=0
  while [ "$waited" -lt "$limit" ]; do
    if [ "$("$adb" -s "$serial" exec-out run-as "$app_id" \
            sh -c "test -f files/$marker && echo yes" 2>/dev/null | tr -d '\r')" = "yes" ]; then
      return 0
    fi
    kill -0 "$android_pid" 2>/dev/null \
      || fail "the Android instrumentation exited before writing $marker"
    apple_fail_if_failed "$(apple_status || true)"
    sleep 1
    waited=$((waited + 1))
  done
  fail "the Android half never wrote $marker within ${limit}s"
}

release_device() {
  "$adb" -s "$serial" exec-out run-as "$app_id" \
    sh -c "printf go > files/$1" >/dev/null 2>&1 \
    || fail "could not release the Android half's $1 barrier"
}

control "$apple_port" POST /start >/dev/null || fail "the Apple fixture refused to start"
# `resident` is a real readiness edge: the shipped lifecycle sets it only once
# the Bonjour listener AND the browser are both ready. Waiting for it means a
# host where the service never registered fails as THAT, rather than as an
# Android-side discovery timeout that blames the wrong end.
wait_for_apple_phase resident 150
apple_peer_name="$(json_field "$(apple_status)" peerName)"
apple_peer_identity="$(json_field "$(apple_status)" peerIdentity)"
[ -n "$apple_peer_name" ] || fail "the Apple fixture reached 'resident' without an advertised name"
[ -n "$apple_peer_identity" ] || fail "the Apple fixture reached 'resident' without an identity"
say "-- the Apple fixture is advertising as '$apple_peer_name' (${apple_peer_identity:0:8}…)"
# Written to files rather than passed as arguments: the advertised name contains
# spaces, and the oracle compares it for exact equality.
printf '%s' "$apple_peer_name" >"$run_root/apple-peer-name.txt"
printf '%s' "$apple_peer_identity" >"$run_root/apple-peer-identity.txt"

# Every extra that is NOT hex-encoded must be free of whitespace, or it splits
# on the device exactly as the hex ones would have. Checked rather than assumed:
# a fixture that grows a space later would otherwise fail as an `am` usage error.
outgoing_plan_hex="$(hex_of "$(cat "$run_root/outgoing-plan.json")")"
for literal in "$apple_peer_identity" "$emulator_origin" "$test_class" "$dial_side" \
               "$outgoing_plan_hex"; do
  case "$literal" in
    *[[:space:]]*) fail "the extra '${literal:0:40}…' contains whitespace; it must travel as hex" ;;
  esac
done

say "== running the Android half =="
"$adb" -s "$serial" shell am instrument -w -r \
  -e class "$test_class" \
  -e apple.peerNameHex "$(hex_of "$apple_peer_name")" \
  -e apple.peerIdentity "$apple_peer_identity" \
  -e apple.dialSide "$dial_side" \
  -e apple.expectOrigin "$emulator_origin" \
  -e apple.messageHex "$(hex_of "$android_message")" \
  -e apple.peerMessageHex "$(hex_of "$apple_message")" \
  -e apple.outgoingPlanHex "$outgoing_plan_hex" \
  "$test_pkg/$runner" >"$run_root/android.log" 2>&1 &
android_pid=$!
register_child instrument-android "$android_pid"

# ── the sequence, each step gated on the previous one's evidence ────────────

# The Android half signals only once it has joined, discovered the Mac and
# checked its identity. Telling the Mac to dial before that would race this
# side's own discovery and read as a product failure.
wait_for_device_marker apple-bidi-discovered.json 300
say "-- the Android half discovered the Mac and verified its identity"

# Discovery is SYMMETRIC and its halves complete at different times, so the
# marker above (the Android half found the Mac) does not imply this one. Waiting
# for the Mac's own answer is what makes a `--dial-side apple` run fail as "the
# Mac never saw the phone" instead of as a refused connect command.
android_target_id="$(wait_for_apple_detail targetId 300)"
[ "$(json_field "$(apple_status)" targetSupportsLink)" = "true" ] \
  || fail "the Mac discovered the Android device but it announced no link/1"
say "-- the Mac discovered the Android device (${android_target_id:0:8}…)"

control "$apple_port" POST /connect >/dev/null \
  || fail "the Apple fixture refused the connect command"
wait_for_apple_phase linked 300
say "-- the link is open on both sides ($dial_side dialled)"

# The MAC opens the conversation and speaks first; the Android half only ever
# answers, so the two never race for it.
control "$apple_port" POST /message >/dev/null || fail "the Apple fixture refused to send its message"
control "$apple_port" POST /files >/dev/null || fail "the Apple fixture refused to send its batch"
say "-- the Mac has sent its message and enqueued its batch"

# Both directions complete on the Mac's own count of batches it has SEEN
# committed and SEEN acknowledged. Not a report from the sender.
wait_for_apple_phase complete 900
say "-- the Mac has committed every inbound batch and had its own confirmed"

# ── the FIRST barrier: read the live link before either side ends it ────────
wait_for_device_marker apple-bidi-ready.json 900
# Taken while the link is UP, because the SAS belongs to a link: a value read
# after the workspace was dismissed would be an earlier link's residue.
control "$apple_port" GET /observed >"$run_root/apple-observed.json" \
  || fail "could not snapshot the Apple fixture's live view at the transfer barrier"
[ -s "$run_root/apple-observed.json" ] \
  || fail "the Apple fixture's barrier snapshot is empty; the SAS cannot be compared"
control "$apple_port" GET /status >"$run_root/apple-status.json" || true
release_device apple-bidi-release
say "-- transfer barrier released"

# ── the SECOND barrier: the roster, which stopping advertising destroys ─────
wait_for_device_marker apple-bidi-room-ready.json 300
control "$apple_port" POST /release >/dev/null || fail "the Apple fixture refused to release its link"
wait_for_apple_phase released 120
control "$apple_port" GET /result >"$run_root/apple-result.json" \
  || fail "could not read the Apple fixture's terminal result"
control "$apple_port" POST /stop-advertising >/dev/null \
  || fail "the Apple fixture refused to stop advertising"
release_device apple-bidi-room-release
say "-- room barrier released"

android_status=0; wait "$android_pid" || android_status=$?
say "-- original exit: android instrumentation $android_status"
[ "$android_status" = 0 ] || fail "the Android instrumentation exited $android_status"
# `am instrument` exits 0 when the process crashes, when the instrumentation
# cannot be found and when it printed nothing at all, so the exit status above
# is necessary and never sufficient.
"$here/lib/instrumentation-result.sh" "$run_root/android.log" 1 \
  || fail "the Android half did not run exactly one passing test (see $run_root/android.log)"

"$adb" -s "$serial" exec-out run-as "$app_id" cat files/apple-bidi-report.json \
  >"$run_root/android-report.json" 2>/dev/null \
  || fail "could not read the Android report"
[ -s "$run_root/android-report.json" ] || fail "the Android report is empty"

# The oracle's inputs, assembled here so every comparison value reaches it as a
# path rather than as an argument that had to survive a shell.
python3 - "$run_root" <<'EXPECT' || fail "the expectations could not be assembled"
import json, sys
root = sys.argv[1]
with open(root + "/expectations-partial.json", encoding="utf-8") as handle:
    expect = json.load(handle)
expect["peerName"] = open(root + "/apple-peer-name.txt", encoding="utf-8").read()
expect["peerIdentity"] = open(root + "/apple-peer-identity.txt", encoding="utf-8").read()
expect["androidMessageFile"] = root + "/expected-android-message.txt"
expect["appleMessageFile"] = root + "/expected-apple-message.txt"
with open(root + "/expectations.json", "w", encoding="utf-8") as handle:
    json.dump(expect, handle, ensure_ascii=True, sort_keys=True)
EXPECT

python3 "$repo/scripts/test/android-nearby-apple-bidirectional-oracle.py" \
  --android "$run_root/android-report.json" \
  --apple-result "$run_root/apple-result.json" \
  --apple-observed "$run_root/apple-observed.json" \
  --expect "$run_root/expectations.json" \
  || fail "the round's own observations do not support a pass"

assert_run_was_local
control "$apple_port" POST /shutdown >/dev/null 2>&1 || true
"$adb" -s "$serial" shell am force-stop "$app_id" >/dev/null 2>&1 || true
preserve_evidence

say ""
say "== Android ↔ Apple over REAL Bonjour, BOTH directions on ONE link =="
say "   The shipped Apple modules ORIGINATED a local-link transfer: their manifest was"
say "   parsed by this Android build, their chunk stream written by its receive path"
say "   through a real system folder picker, and their sealed text frame decoded — while"
say "   this build's own three batches were read back by the Apple receipt writer."
say "   Every file was compared by name, path, size and SHA-256 at the RECEIVING side."
say "   Dial assignment: $dial_side."
say "   The Apple half is the shipped transport compiled on this host. It is NOT an iOS"
say "   binary and NOT a physical device: a Mac running shipped modules is not an iPhone."
completed=1
