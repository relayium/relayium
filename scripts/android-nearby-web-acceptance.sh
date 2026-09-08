#!/usr/bin/env bash
#
# **One real Android device and THREE real browser devices in one code-less
# room, with the phone choosing which browser it talks to.**
#
#   ./scripts/android-nearby-web-acceptance.sh <serial>
#
# The cell nothing else in this repository fills. `android-nearby-acceptance.sh`
# puts two copies of THIS implementation on one link — and two copies of one bug
# agree perfectly. `android-nearby-apple-acceptance.sh` puts this build in front
# of the Apple modules over Bonjour: one direction, one candidate.
# `android-interop-acceptance.sh` reaches the browser through a PAIRING CODE,
# which is a different rendezvous with a different room shape and no device list
# at all.
#
# This round is the code-less ROOM: a WebSocket rendezvous the server keys by
# the address it observes — the same room the Android app's "Search through
# relayium.com" mode joins — carrying a session between this build and the
# shipped browser bundle in BOTH directions, with two DECOY browser devices in
# the room that must never be dialled.
#
# ## What is real here
#
#   * one real Android instance running the real debug APK through its OWN
#     `MainActivity`/`TransferViewModel`, with the REAL system document picker
#     on both the send and the receive side;
#   * three INDEPENDENT browser devices on the real built bundle — independent
#     because each tab overrides `relayium.lan.seed`, the one key the room
#     groups a browser's tabs by, so three tabs of one profile are three DEVICES
#     rather than one;
#   * a THROWAWAY server this run starts and kills, reached from the emulator as
#     `10.0.2.2:<port>` and from the browsers as `127.0.0.1:<port>` — the same
#     room either way, because the server keys it by the address it observes;
#   * real native WebRTC, one real `link/1` session, one real SAS.
#
# ## What it proves
#
# The phone lists at least three candidates; the target is NOT first in either
# the order the model offers or the order the screen shows; and the phone
# connects to the one it was told to — through a tap on THAT ROW's own button,
# not a view-model call that would skip the row-to-peer binding entirely. Both
# decoys are asserted never to have been dialled, at the wire and on screen,
# across the WHOLE run. Then: a matching six-digit SAS on both sides, text in
# both directions compared by equality including whitespace and non-ASCII, and
# files in both directions compared PER FILE by name, path, size and SHA-256 —
# including a body that crosses the 192 KiB fragment boundary, a zero-byte file,
# and a file that lands at a NESTED non-ASCII path.
#
# ## The negative control
#
#   RELAYIUM_NEARBY_WEB_NEGATIVE=wrong-selection \
#     ./scripts/android-nearby-web-acceptance.sh <serial>
#
# makes the Android half tap the FIRST row instead of the named target. The run
# must then FAIL, and this script reports success only if it did. An acceptance
# whose central invariant cannot be made to fail is not evidence of anything.
#
# ## What a green run does NOT prove
#
# Emulator or developer hardware, never a physical phone. One room shape (the
# hub); the direct path is a separate lane. And two seams on the browser side
# are stubbed, both of them OS dialogs a headless run cannot answer — Save-as,
# and the relative path a folder pick would supply. See the header of
# `web/e2e/android-nearby-hub.mjs` for exactly what they do and do not do.
set -Eeuo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$here/.." && pwd)"
# shellcheck source-path=SCRIPTDIR
# shellcheck source=lib/local-acceptance.sh
source "$here/lib/local-acceptance.sh"

[ $# -ge 1 ] || { say "usage: $0 <serial>"; exit 2; }
serial="$1"

gradle_bin="${RELAYIUM_GRADLE:-$repo/apps/android/gradlew}"
adb="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-}}/platform-tools/adb"

# The instrumentation lives in its OWN package. `com.relayium.android.debug` is
# the app; the runner is registered under `com.relayium.android.debug.test`, and
# naming the app package here produces "Unable to find instrumentation info" —
# which `am instrument` reports while exiting 0.
app_id="com.relayium.android.debug"
test_pkg="$app_id.test"
runner="androidx.test.runner.AndroidJUnitRunner"
test_class="com.relayium.android.nearby.NearbyWebCounterpartTest#exchangesWithThreeBrowserDevicesInTheCodelessRoom"

# The REAL DocumentsUI round trip is the default. Opting out is explicit, and the
# report records which happened so the oracle can refuse a skipped one.
real_picker="${RELAYIUM_NEARBY_WEB_REAL_PICKER:-1}"
negative="${RELAYIUM_NEARBY_WEB_NEGATIVE:-}"
case "$negative" in
  ""|wrong-selection) ;;
  *) say "RELAYIUM_NEARBY_WEB_NEGATIVE must be empty or 'wrong-selection'"; exit 2 ;;
esac

# ── the browser devices, and why these names ────────────────────────────────
#
# `nearbyDevices` (NearbyDevices.kt) SORTS the list by name, so the name decides
# where a device appears on the phone's screen. The target is named so that it
# sorts LAST, and the browser half also joins it LAST — so neither "the first
# entry in the roster" nor "the first row on screen" is the target, and a client
# that picked either way would connect to a DECOY and fail the round rather than
# passing it while proving nothing.
decoy_one="relayium-web-decoy-01"
decoy_two="relayium-web-decoy-02"
target_name="relayium-web-target-zz"

# ── the fixtures ────────────────────────────────────────────────────────────
#
# Sizes and seeds only. The bytes are generated on all three sides from the SAME
# rule — `(i * 31 + seed) % 251` — and compared by digest, so a drift between
# those implementations is a failed round rather than a silent pass. They never
# travel as arguments: a 300 KiB body as hex is 614 400 characters in one argv
# entry, past `MAX_ARG_STRLEN`, and it surfaces as an unrelated `am` usage error
# rather than as anything about size.
#
#   307_200  crosses the 192 KiB (196_608 B) logical fragment boundary
#         0  has no CHUNK at all and completes on DONE
android_large_name="android-large.bin"; android_large_seed=17;  android_large_bytes=307200
android_zero_name="android-zero.bin";   android_zero_seed=211;  android_zero_bytes=0
web_large_name="web-large.bin";         web_large_seed=41;      web_large_bytes=307200
web_zero_name="web-zero.bin";           web_zero_seed=7;        web_zero_bytes=0
# A NESTED, non-ASCII path with a space in a directory name. `name` is the leaf
# and `path` carries the directories, which is exactly the shape the Web sends
# and the shape `Filename.resolveRelativePath` is written for. Reachable only in
# this direction: an Android send goes through ACTION_OPEN_DOCUMENT, which
# yields a document and no relative path at all.
web_nested_leaf="файл-测试.bin"
web_nested_path="外层 目录/内层/файл-测试.bin"
web_nested_seed=99
web_nested_bytes=1234

acceptance_begin

# Every path inside the run root, named the moment the root exists.
#
# `acceptance_extra_cleanup` runs on EVERY exit — including a preflight or build
# failure hundreds of lines before the round starts — and it reads these. Under
# `set -u` an unbound name there would abort the cleanup silently, taking the
# report capture with it, which is precisely the evidence a failed run needs.
browser_ready="$run_root/browser-ready"
browser_release="$run_root/browser-release"
browser_room_ready="$run_root/browser-room-ready"
browser_room_release="$run_root/browser-room-release"
browser_out="$run_root/browser.json"
android_out="$run_root/android-report.json"

# Device-side state this run changed, restored whatever way the run ends.
# `acceptance_extra_cleanup` runs before the child processes are terminated and
# is never allowed to fail the cleanup it runs inside.
# Restoring `debug.relayium.backend`, and the two ways that goes wrong.
#
# **Clearing is not restoring.** A device already pointed at someone's staging
# server would be silently reset, and the next run of anything on it would
# resolve somewhere nobody chose. So the value is captured BEFORE the override
# and the exact original is put back.
#
# **A run that never overrode it must not touch it.** `acceptance_extra_cleanup`
# runs on EVERY exit path, including a preflight or build failure long before
# the capture — and a cleanup that unconditionally "restored" would then be
# mutating a property this run never changed. Hence a flag that is set only
# after a successful capture AND a successful override, and a cleanup with no
# `else` branch.
#
# The restore command is a COMPLETE, already-quoted remote command line, built
# once by the capture below. `adb shell` re-joins its argv into one remote
# command line, so a value assembled here from fragments could split or execute;
# passing one pre-quoted string means the remote `sh` parses exactly what was
# intended. A value that cannot be represented that way is refused BEFORE the
# override, so the property is left as it was rather than lost.
backend_overridden=0
backend_restore_cmd=""

acceptance_extra_cleanup() {
  # The phone's report FIRST, and before the force-stop.
  #
  # The instrumentation writes it from a `finally`, so a FAILED round produces
  # one too — and that partial is the most valuable artefact a failed round has:
  # v1's carried the selected id, both candidate orders, the wire and the SAS,
  # all of which had already been established when the round died. The judge
  # returns early on a failed test and never reached its own pull, so without
  # this the artifact hook copied a file that was never fetched.
  capture_native_report || true
  "$adb" -s "$serial" shell am force-stop "$app_id" >/dev/null 2>&1 || true
  if [ "$backend_overridden" = 1 ]; then
    "$adb" -s "$serial" shell "$backend_restore_cmd" >/dev/null 2>&1 || true
  fi
  snapshot_artifacts || true
}

# Best-effort, and JSON or nothing.
#
# `run-as` writes its own diagnostics ("Package ... is unknown", "not debuggable")
# to stdout on some builds, so an unchecked redirect stores an error MESSAGE
# under the name of a report — which a later reader would try to judge. A report
# that does not parse is worse than no report, so the candidate is validated
# before it is allowed to become one, and an existing good report is never
# overwritten by a worse capture.
capture_native_report() {
  [ -n "${run_root:-}" ] && [ -d "$run_root" ] || return 0
  local candidate="$run_root/android-report.candidate"
  "$adb" -s "$serial" exec-out run-as "$app_id" cat files/nearby-web-report.json \
    >"$candidate" 2>/dev/null || true
  if [ -s "$candidate" ] \
     && python3 -c 'import json,sys; json.load(open(sys.argv[1]))' "$candidate" 2>/dev/null; then
    mv "$candidate" "$android_out"
  else
    rm -f "$candidate"
  fi
  return 0
}

# ── artifact preservation ───────────────────────────────────────────────────
#
# `lib/local-acceptance.sh` keeps the per-run root only on FAILURE, so a passing
# run — and a HELD negative control, which is a passing run — leaves nothing
# behind. This copies the evidence somewhere durable on EVERY path, including
# an interrupt, when the caller names a destination.
#
# An explicit allowlist, not the whole root: the run root also holds a 35 MB
# server binary, its database and its blob directory, none of which is evidence
# and one of which is large. Nothing here is a credential — the fixtures are the
# round's own generated payload descriptors and the logs are this run's.
snapshot_artifacts() {
  [ -n "${RELAYIUM_NEARBY_WEB_ARTIFACTS:-}" ] || return 0
  [ -n "${run_root:-}" ] && [ -d "$run_root" ] || return 0
  local dest="$RELAYIUM_NEARBY_WEB_ARTIFACTS/${run_tag:-unknown}"
  mkdir -p "$dest" || return 0
  local name
  for name in android.log browser.log gradle.log go-build.log web-build.log server.log \
              android-report.json browser.json expect.json plan.json extras.sh \
              negative-judgement.txt browser-ready browser-release \
              browser-room-ready browser-room-release \
              android-message.txt web-message.txt ready-message.txt \
              backend-before.raw; do
    [ -e "$run_root/$name" ] && cp -p "$run_root/$name" "$dest/$name" 2>/dev/null
  done
  say "--- artifacts copied to $dest"
  return 0
}

[ -x "$adb" ] || fail "no adb at $adb — set ANDROID_HOME or ANDROID_SDK_ROOT"
"$adb" -s "$serial" shell true >/dev/null 2>&1 \
  || fail "device $serial is not reachable through adb"
command -v go >/dev/null 2>&1 || fail "this round needs the Go toolchain to build the server"
node_bin="${RELAYIUM_NODE:-node}"
command -v "$node_bin" >/dev/null 2>&1 \
  || fail "this round needs Node for the browser half (set RELAYIUM_NODE)"

# The Web dependencies, checked BEFORE anything is built.
#
# `npx vite build` on a tree with no `node_modules` does not fail — it goes and
# FETCHES a vite, which is a several-minute network install in the middle of an
# acceptance and a different vite from the one this bundle is pinned to. A
# worktree that has never had `npm ci` run in it is a setup problem, and saying
# so takes a second.
[ -f "$repo/web/node_modules/vite/bin/vite.js" ] \
  || fail "web/node_modules is missing or has no vite; run 'npm ci' in $repo/web first.
   Without it 'npx vite build' would silently fetch a DIFFERENT vite over the network."

# ── preflight: the browser half's own injected scripts ──────────────────────
#
# BEFORE the builds, because it costs a second and the alternative is finding
# out after four minutes of Gradle. These scripts run inside a page, which is the
# one place a mistake in them is SILENT — a boot script that throws installs no
# latch, and a latch that never looked reports exactly the zeroes a clean decoy
# does — so the round refuses to start until they have been parsed and exercised.
say "== preflight: the browser half's injected page scripts =="
( cd "$repo/web" && "$node_bin" e2e/android-nearby-hub.mjs --self-check ) \
  || fail "the browser half's injected page scripts did not pass their own self-check"

# ── the digests the oracle compares against, from the SAME rule ─────────────
digest_of() {
  python3 -c '
import hashlib, sys
seed, count = int(sys.argv[1]), int(sys.argv[2])
print(hashlib.sha256(bytes((i * 31 + seed) % 251 for i in range(count))).hexdigest())
' "$1" "$2"
}
android_large_sha="$(digest_of "$android_large_seed" "$android_large_bytes")"
android_zero_sha="$(digest_of "$android_zero_seed" "$android_zero_bytes")"
web_large_sha="$(digest_of "$web_large_seed" "$web_large_bytes")"
web_zero_sha="$(digest_of "$web_zero_seed" "$web_zero_bytes")"
web_nested_sha="$(digest_of "$web_nested_seed" "$web_nested_bytes")"
say "== fixtures: android $android_large_bytes+$android_zero_bytes bytes,"
say "   web $web_large_bytes+$web_zero_bytes+$web_nested_bytes bytes (one nested non-ASCII path)"

# ── build: the server, the bundle, the APKs ─────────────────────────────────
say "== building the throwaway server =="
( cd "$repo/server" && go build -o "$run_root/relayium-server" . ) \
  >"$run_root/go-build.log" 2>&1 \
  || fail "the server did not build: $(tail -20 "$run_root/go-build.log")"
[ -x "$run_root/relayium-server" ] || fail "no server binary at $run_root/relayium-server"

# `vite build` rather than `npm run build`: the latter runs `gen-pages.mjs`,
# which REWRITES committed static pages, so a run of this script would leave the
# working tree dirty in files it has nothing to do with.
#
# And the module is run through `$node_bin` rather than through
# `node_modules/.bin/vite`, whose shebang would pick up whatever `node` is on
# PATH — so a run that carefully selected a Node for the browser half would build
# the bundle with a different one.
say "== building the Web bundle (node: $node_bin) =="
( cd "$repo/web" && "$node_bin" node_modules/vite/bin/vite.js build \
    >"$run_root/web-build.log" 2>&1 ) \
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
[ -f "$app_apk" ] || fail "no debug APK at $app_apk"
[ -f "$test_apk" ] || fail "no instrumentation APK at $test_apk"

say "== installing on $serial =="
"$adb" -s "$serial" install -r -t "$app_apk" >/dev/null \
  || fail "could not install the app on $serial"
"$adb" -s "$serial" install -r -t "$test_apk" >/dev/null \
  || fail "could not install the instrumentation on $serial"
# App data survives a reinstall, so a previous run's disposable tree and its
# barrier markers would otherwise still be there. Before `setprop`, never after:
# the override is a system property and a clear does not touch it, but the ORDER
# is what keeps that true if either ever changes.
"$adb" -s "$serial" shell pm clear "$app_id" >/dev/null 2>&1 || true

# ── the server, and the origin each side reaches it at ──────────────────────
#
# `acceptance_start_server` EXECUTES `$run_root/relayium-server`; it does not
# build one, which is why the Go build above is explicit.
acceptance_start_server
# The emulator reaches the host's loopback as 10.0.2.2. `Backend.resolve` PARSES
# this and accepts only an exact local origin. Clearing the override instead
# would resolve to `Backend.PRODUCTION`, which is how an acceptance ends up
# driving the real service; the instrumentation additionally compares its own
# resolved origin against the one this script says it set and fails if they
# differ.
android_origin="http://10.0.2.2:$server_port"

# ── capture, and build the restore command, BEFORE any mutation ─────────────
#
# Written to a file rather than taken through `$( … )`, because a command
# substitution strips EVERY trailing newline and this needs to strip exactly the
# ONE line terminator `getprop` adds — a value that genuinely ended in
# whitespace is a different value, and quietly trimming it is the same class of
# mistake as clearing it.
"$adb" -s "$serial" shell getprop debug.relayium.backend >"$run_root/backend-before.raw" 2>/dev/null \
  || fail "could not read $serial's current debug.relayium.backend; refusing to override a
   property whose original value this run could not put back"
backend_restore_cmd="$(python3 -c '
import shlex
import sys

raw = open(sys.argv[1], "rb").read()
# Exactly one terminator: the one adb appends (CRLF over the transport). A
# command substitution would have stripped EVERY trailing newline, and a value
# that genuinely ended in whitespace is a different value — trimming it quietly
# is the same class of mistake as clearing it.
if raw.endswith(b"\r\n"):
    raw = raw[:-2]
elif raw.endswith(b"\n"):
    raw = raw[:-1]
try:
    value = raw.decode("utf-8")
except UnicodeDecodeError:
    print("UNREPRESENTABLE", end="")
    sys.exit(0)
# A control character cannot survive a remote command line faithfully, and
# getprop line-oriented output could not have expressed it unambiguously in the
# first place. Refuse rather than guess.
if any(ord(c) < 0x20 or ord(c) == 0x7F for c in value):
    print("UNREPRESENTABLE", end="")
    sys.exit(0)
# One complete, already-quoted remote command. shlex.quote of the empty string
# is a pair of quotes, which sets the property empty — the faithful restoration
# of "it was not set".
print("setprop debug.relayium.backend " + shlex.quote(value), end="")
' "$run_root/backend-before.raw")" \
  || fail "could not prepare the restore command for $serial debug.relayium.backend"
if [ "$backend_restore_cmd" = "UNREPRESENTABLE" ]; then
  fail "this device's existing debug.relayium.backend cannot be restored faithfully through
   adb shell, so this run will NOT override it — leaving it exactly as it is beats
   losing it. Clear or correct it by hand on $serial and run this again."
fi

"$adb" -s "$serial" shell setprop debug.relayium.backend "$android_origin" \
  || fail "could not point $serial at $android_origin"
# Only NOW: the property really is this run's to put back. Before this line the
# cleanup leaves it alone, so a preflight or build failure cannot reset a device
# this run never changed.
backend_overridden=1
[ "$("$adb" -s "$serial" shell getprop debug.relayium.backend | tr -d '\r')" = "$android_origin" ] \
  || fail "the backend property did not take on $serial"
say "-- the phone is pointed at $android_origin; the browsers at $origin"

# ── the fixtures that are text ──────────────────────────────────────────────
#
# Written to FILES, never passed as arguments. These are whitespace-significant
# and non-ASCII, and a value that had to survive two levels of shell quoting —
# and then `adb shell`'s re-joining of argv — is not a reliable fixture. The
# same lesson `android-interop-acceptance.sh` records for its own message.
#
# The two directions carry deliberately different whitespace. The browser's body
# has a leading run of spaces on its second line, a TAB and a trailing newline,
# because a textarea's value is set programmatically and every byte of it
# survives to `.msg-body`'s text node. The phone's body has leading spaces and
# no trailing ones, because it is typed into a real Compose field through
# `performTextReplacement` and this round is not the place to discover what an
# IME does with a trailing tab.
printf '%s' '  from-android · 边界 → ✓ Ünïcode' >"$run_root/android-message.txt"
printf '%s' 'from-browser
  二行	制表 · ünïcode ✓
' >"$run_root/web-message.txt"
printf '%s' 'relayium-nearby-web:ready' >"$run_root/ready-message.txt"

plan="$run_root/plan.json"
expect="$run_root/expect.json"
extras="$run_root/extras.sh"

python3 - <<'PY' \
  "$plan" "$expect" "$extras" "$run_root" \
  "$target_name" "$decoy_one" "$decoy_two" "$real_picker" "$negative" \
  "$android_large_name" "$android_large_seed" "$android_large_bytes" "$android_large_sha" \
  "$android_zero_name" "$android_zero_seed" "$android_zero_bytes" "$android_zero_sha" \
  "$web_large_name" "$web_large_seed" "$web_large_bytes" "$web_large_sha" \
  "$web_zero_name" "$web_zero_seed" "$web_zero_bytes" "$web_zero_sha" \
  "$web_nested_leaf" "$web_nested_path" "$web_nested_seed" "$web_nested_bytes" "$web_nested_sha" \
  || fail "could not write this round's plan"
"""Write the browser's plan, the oracle's expectations, and the hex-encoded
instrumentation extras.

Three consumers, ONE source. Writing the same fixture out three times by hand is
how a round ends up asserting a file the other half never sent.
"""
import json
import sys

(plan_path, expect_path, extras_path, run_root,
 target, decoy_one, decoy_two, real_picker, negative,
 a_large_name, a_large_seed, a_large_bytes, a_large_sha,
 a_zero_name, a_zero_seed, a_zero_bytes, a_zero_sha,
 w_large_name, w_large_seed, w_large_bytes, w_large_sha,
 w_zero_name, w_zero_seed, w_zero_bytes, w_zero_sha,
 w_nested_leaf, w_nested_path, w_nested_seed, w_nested_bytes, w_nested_sha) = sys.argv[1:]


def read(name):
    with open(f"{run_root}/{name}", encoding="utf-8") as handle:
        return handle.read()


android_message = read("android-message.txt")
web_message = read("web-message.txt")
ready_message = read("ready-message.txt")

# What the BROWSER sends: ONE batch of three entries. One entry never exercises
# the global file sequence ACROSS entries, and the nested path only means
# anything inside a batch that also carries flat ones.
browser_batch = [
    {"name": w_large_name, "size": int(w_large_bytes), "seed": int(w_large_seed)},
    {"name": w_zero_name, "size": int(w_zero_bytes), "seed": int(w_zero_seed)},
    {"name": w_nested_leaf, "path": w_nested_path,
     "size": int(w_nested_bytes), "seed": int(w_nested_seed)},
]
# What the browser must end up having SAVED, by name. The oracle compares the
# sizes and digests; this list is only what the browser half waits for.
browser_expect_saved = [
    {"name": a_large_name, "size": int(a_large_bytes)},
    {"name": a_zero_name, "size": int(a_zero_bytes)},
]

with open(plan_path, "w", encoding="utf-8") as handle:
    json.dump({
        "message": web_message,
        "expectMessage": android_message,
        "readyMessage": ready_message,
        "batches": [browser_batch],
        "expectSaved": browser_expect_saved,
    }, handle, ensure_ascii=False, indent=1)

with open(expect_path, "w", encoding="utf-8") as handle:
    json.dump({
        "targetName": target,
        "decoyNames": [decoy_one, decoy_two],
        "realPicker": real_picker != "0",
        "negative": negative,
        "messages": {
            "androidToBrowser": android_message,
            "browserToAndroid": web_message,
            "ready": ready_message,
        },
        # Android → the browser. Flat, because an Android send has no relative
        # path to give.
        "androidSends": [
            {"name": a_large_name, "size": int(a_large_bytes), "sha256": a_large_sha},
            {"name": a_zero_name, "size": int(a_zero_bytes), "sha256": a_zero_sha},
        ],
        # The browser → Android, by the DOCUMENT ID each file must land at in the
        # phone's tree, which for a nested entry is its whole relative path.
        "browserSends": [
            {"name": w_large_name, "path": w_large_name,
             "size": int(w_large_bytes), "sha256": w_large_sha},
            {"name": w_zero_name, "path": w_zero_name,
             "size": int(w_zero_bytes), "sha256": w_zero_sha},
            {"name": w_nested_leaf, "path": w_nested_path,
             "size": int(w_nested_bytes), "sha256": w_nested_sha},
        ],
    }, handle, ensure_ascii=False, indent=1)

# ── the instrumentation extras, hex-encoded ─────────────────────────────────
#
# `adb shell` re-joins argv into ONE remote command line, so host-side quoting
# does not survive it: an extra containing a space SPLITS, and a non-ASCII one is
# re-encoded by whatever the device shell believes its locale is. Both surface as
# an unrelated `am` usage error or as a fragment landing on the runner, never as
# anything about the value. Hex is the convention the Apple counterpart round
# already uses; the fixtures keep their spaces and their non-ASCII characters,
# because those are what this round exists to move.
def hexed(value):
    return value.encode("utf-8").hex()


expect_files = "\n".join(
    f"{entry['path']}\t{entry['size']}\t{entry['sha256']}"
    for entry in (
        {"path": w_large_name, "size": int(w_large_bytes), "sha256": w_large_sha},
        {"path": w_zero_name, "size": int(w_zero_bytes), "sha256": w_zero_sha},
        {"path": w_nested_path, "size": int(w_nested_bytes), "sha256": w_nested_sha},
    )
)

with open(extras_path, "w", encoding="utf-8") as handle:
    for name, value in (
        ("target_name_hex", hexed(target)),
        ("decoy_names_hex", hexed(f"{decoy_one}\n{decoy_two}")),
        ("android_message_hex", hexed(android_message)),
        ("web_message_hex", hexed(web_message)),
        ("ready_message_hex", hexed(ready_message)),
        ("expect_files_hex", hexed(expect_files)),
    ):
        handle.write(f"{name}={value}\n")
PY

# Hex only: every value in this file is `[0-9a-f]*`, so sourcing it cannot
# execute anything a fixture smuggled in. Checked rather than assumed, because
# "it is generated" is a property of today's generator.
if grep -Eqv '^[a-z_]+=[0-9a-f]*$' "$extras"; then
  fail "the generated extras file contains something other than hex assignments"
fi
# shellcheck source=/dev/null
source "$extras"

# Read back, so a generator that stopped emitting one of these fails HERE rather
# than as an `am` usage error about a missing extra thirty lines later. This is
# also why the references below carry a ShellCheck directive: the variables are
# real, they simply arrive from a file ShellCheck cannot follow, and each one is
# proved present and hexadecimal before it is used.
for _name in target_name_hex decoy_names_hex android_message_hex web_message_hex \
             ready_message_hex expect_files_hex; do
  eval "_value=\${$_name:-}"
  [ -n "$_value" ] || fail "the generated extras file has no $_name"
  case "$_value" in
    *[!0-9a-f]*) fail "the generated $_name is not hexadecimal" ;;
  esac
done
unset _name _value

# ── the barrier files ───────────────────────────────────────────────────────

# ── the Android half ────────────────────────────────────────────────────────
# Optional argument list. EVERY expansion below uses the `${name+"${name[@]}"}`
# form, and it is not style: macOS ships Bash **3.2**, where `"${empty[@]}"`
# under `set -u` is an UNBOUND VARIABLE error rather than the empty expansion
# Bash 4.4+ produces — so the bare form would fail exactly the ordinary run.
# `if`, not `&&`: under `set -e` a false test as the left half of an `&&` list
# ends the script.
declare -a negative_args=()
if [ "$negative" = "wrong-selection" ]; then
  negative_args=(-e web.wrongSelection 1)
fi

say "== starting the Android half (real picker=$real_picker${negative:+, NEGATIVE CONTROL: $negative}) =="
# shellcheck disable=SC2154  # every *_hex comes from "$extras", validated above.
"$adb" -s "$serial" shell am instrument -w -r \
  -e class "$test_class" \
  -e web.expectOrigin "$android_origin" \
  -e web.realPicker "$real_picker" \
  -e web.targetNameHex "$target_name_hex" \
  -e web.decoyNamesHex "$decoy_names_hex" \
  -e web.messageHex "$android_message_hex" \
  -e web.peerMessageHex "$web_message_hex" \
  -e web.readyMessageHex "$ready_message_hex" \
  -e web.expectFilesHex "$expect_files_hex" \
  -e web.outLargeName "$android_large_name" \
  -e web.outLargeSeed "$android_large_seed" \
  -e web.outLargeBytes "$android_large_bytes" \
  -e web.outZeroName "$android_zero_name" \
  -e web.outZeroSeed "$android_zero_seed" \
  -e web.outZeroBytes "$android_zero_bytes" \
  ${negative_args+"${negative_args[@]}"} \
  "$test_pkg/$runner" >"$run_root/android.log" 2>&1 &
android_pid=$!
register_child instrument "$android_pid"

# ── the name the phone is ACTUALLY announcing ───────────────────────────────
#
# Read from the device rather than guessed. The browser half matches it with
# `===`, and a defaulted or assumed value would let three browsers "see the
# phone" in a room the phone had never joined — `"".includes("")` is true, which
# is exactly how that passed once.
# The file does not exist until the phone has joined the room, and "not yet" is
# the ORDINARY state for most of this wait. It must not end the run: under
# `set -e` with `pipefail`, a `$( ... | ... )` whose first stage failed is a
# non-zero command substitution, and the loop below would die on its first
# iteration every single time.
#
# So the status is captured explicitly and the two cases are told apart. A
# missing file is expected; a device that stopped answering `adb` is not, and
# after a bounded run of those the round fails as the transport failure it is
# rather than timing out with a message about a name.
identity_raw=""
read_identity() {
  local out="" status=0
  out="$("$adb" -s "$serial" exec-out run-as "$app_id" \
        cat files/nearby-web-identity.json 2>/dev/null)" || status=$?
  identity_raw="$(printf '%s' "$out" | tr -d '\r')"
  return "$status"
}

android_name=""
waited=0
transport_failures=0
while [ "$waited" -lt 300 ]; do
  kill -0 "$android_pid" 2>/dev/null \
    || fail "the Android half exited before it announced a name: $(tail -30 "$run_root/android.log")"
  if read_identity && [ -n "$identity_raw" ]; then
    transport_failures=0
    android_name="$(printf '%s' "$identity_raw" | python3 -c '
import json, sys
try:
    print(json.load(sys.stdin).get("name", ""), end="")
except Exception:
    pass
')"
    [ -n "$android_name" ] && break
  elif "$adb" -s "$serial" shell true >/dev/null 2>&1; then
    # The device answers; the file simply is not there yet.
    transport_failures=0
  else
    transport_failures=$((transport_failures + 1))
    if [ "$transport_failures" -ge 10 ]; then
      fail "device $serial stopped answering adb while this run waited for the phone to
   announce its name; the round cannot continue and this is not a Nearby failure"
    fi
  fi
  sleep 1
  waited=$((waited + 1))
done
[ -n "$android_name" ] \
  || fail "the phone never published the name it joined the room under (after ${waited}s)"
say "-- the phone joined the room as '$android_name'"

# ── the browser half ────────────────────────────────────────────────────────
#
# `exec`, so the PID registered below IS the Node process. Without it the
# backgrounded subshell is what `$!` names: cleanup TERMs the subshell, Node
# never sees a signal, and Node plus its Chrome outlive the run with PPID 1.
# Node's own handlers — registered before it spawns anything — then close the
# Chrome it owns, whether the signal lands before or after CDP came up.
(
  cd "$repo/web" && exec "$node_bin" e2e/android-nearby-hub.mjs \
    --origin "$origin" \
    --android-name "$android_name" \
    --target-name "$target_name" \
    --decoy-names "$decoy_one,$decoy_two" \
    --plan "$plan" \
    --out "$browser_out" \
    --ready-file "$browser_ready" \
    --release-file "$browser_release" \
    --room-ready-file "$browser_room_ready" \
    --room-release-file "$browser_room_release"
) >"$run_root/browser.log" 2>&1 &
browser_pid=$!
register_child browser "$browser_pid"

# ── the two-endpoint barrier ────────────────────────────────────────────────
#
# Neither half may tear its side down while the other is still asserting against
# it. This launcher is the only process that can see both, so it is the only
# thing that can answer "are both done?". Each half writes its marker only after
# every assertion it owns has passed; both are released together. Deliberately
# NOT a sleep, which would prove nothing about the other side, and deliberately
# not the transfer's own wire, which is the thing under test.
device_ready() {
  [ "$("$adb" -s "$serial" exec-out run-as "$app_id" \
        sh -c "test -f files/$1 && echo yes" 2>/dev/null | tr -d '\r')" = "yes" ]
}
device_release() {
  "$adb" -s "$serial" exec-out run-as "$app_id" \
    sh -c "printf go > files/$1" >/dev/null 2>&1
}

barrier_timeout=300
# One phase: wait for BOTH halves to declare it, then release both together.
# Always returns 0 — a barrier that gave up must let each half report what IT was
# waiting for, rather than becoming the failure itself.
run_barrier_phase() {
  local name="$1" device_marker="$2" device_rel="$3" host_marker="$4" host_rel="$5" waited=0
  while [ "$waited" -lt "$barrier_timeout" ]; do
    if ! kill -0 "$android_pid" 2>/dev/null || ! kill -0 "$browser_pid" 2>/dev/null; then
      say "-- barrier[$name]: a half exited before both were ready; releasing so the"
      say "   survivor reports its own failure rather than the barrier's"
      device_release "$device_rel"; : >"$host_rel"
      return 0
    fi
    if device_ready "$device_marker" && [ -f "$host_marker" ]; then
      say "-- barrier[$name]: both halves reached it; releasing together"
      device_release "$device_rel"; : >"$host_rel"
      return 0
    fi
    sleep 1
    waited=$((waited + 1))
  done
  say "-- barrier[$name]: timed out after ${barrier_timeout}s; releasing so each half"
  say "   reports what it was actually waiting for"
  device_release "$device_rel"; : >"$host_rel"
  return 0
}

# TWO phases, because there are two separate moments at which one endpoint's
# ordinary next step destroys something the other is still asserting against.
# `transfer` guards the SESSION: the phone's message history is session state and
# the browser reads its own save ledger after its assertions. `room` guards the
# ROSTER: three browser devices leaving the room would correctly empty the
# phone's list while it checks that the room survived its own transfer.
run_barriers() {
  run_barrier_phase transfer \
    nearby-web-ready.json nearby-web-release "$browser_ready" "$browser_release"
  run_barrier_phase room \
    nearby-web-room-ready.json nearby-web-room-release "$browser_room_ready" "$browser_room_release"
}
run_barriers &
register_child barrier $!

android_status=0; wait "$android_pid" || android_status=$?
browser_status=0; wait "$browser_pid" || browser_status=$?
say "-- original exits: android(am instrument) $android_status, browser $browser_status"

# Immediately, whatever those exits were. Every judging path below can return
# early, and the phone's report is the evidence a FAILED round most needs.
capture_native_report
if [ -s "$android_out" ]; then
  say "-- captured the phone's report ($(wc -c <"$android_out" | tr -d ' ') bytes)"
else
  say "-- the phone left no readable report"
fi

# ── judging ─────────────────────────────────────────────────────────────────
#
# A FUNCTION returning a status rather than a run of `fail`s, because the
# negative control needs to observe a failure without the script treating it as
# one. Every message still names what disagreed.
# What each half OBSERVED, whatever the round's outcome. Both write their
# observations from a `finally`, so a failed round produces them too — which is
# exactly what the negative control needs, and exactly why the existence of these
# files is never treated as a pass.
collect() {
  capture_native_report
  [ -s "$android_out" ] || { say "COLLECT: the phone wrote no readable report"; return 1; }
  [ -s "$browser_out" ] || { say "COLLECT: the browser half wrote no observation"; return 1; }
  return 0
}

judge() {
  # `am instrument` exits 0 almost unconditionally — including when the process
  # crashed and when the instrumentation could not be found — so the ORIGINAL
  # exit is reported above and the RESULT is judged from the status stream.
  if [ "$android_status" != 0 ]; then
    say "JUDGE: the Android half's am instrument exited $android_status"
    return 1
  fi
  if ! "$here/lib/instrumentation-result.sh" "$run_root/android.log" 1; then
    say "JUDGE: the Android half did not run exactly one passing test"
    say "$(tail -40 "$run_root/android.log")"
    return 1
  fi
  if [ "$browser_status" != 0 ]; then
    say "JUDGE: the browser half failed"
    say "$(tail -40 "$run_root/browser.log")"
    return 1
  fi
  collect || return 1
  python3 "$repo/scripts/test/android-nearby-oracle.py" --counterpart web \
    "$android_out" "$browser_out" "$expect"
}

# The control's OWN evidence, and it is a different question from "did the round
# fail". A crash, a missing runner, an APK that never built or a plain timeout
# all make a round fail and none of them says anything about whether a wrong
# selection is DETECTABLE — so this judge requires the phone to have listed three
# candidates, tapped the first row, connected to a DECOY, and the browser half to
# have independently seen that decoy dialled.
judge_negative() {
  python3 "$repo/scripts/test/android-nearby-oracle.py" --counterpart web-negative \
    "$android_out" "$browser_out" "$expect"
}

if [ "$negative" = "wrong-selection" ]; then
  # A control that failed because the emulator never booted proves nothing about
  # the selection invariant. So BOTH halves must have run far enough to write
  # their observations before the failure counts as the one this control is for —
  # an inconclusive control is reported as inconclusive, not as "held".
  collect \
    || fail "the NEGATIVE CONTROL is INCONCLUSIVE: one half never wrote its observations,
   so this run says nothing about whether a wrong selection is detectable.
   Evidence kept under $run_root"
  say "-- both halves produced observations; judging them =="
  # Captured and re-printed, because a held control is a SUCCESSFUL run and
  # `lib/local-acceptance.sh` removes the run root on success — so the reason it
  # failed has to be in this transcript, not only on disk.
  if judge >"$run_root/negative-judgement.txt" 2>&1; then
    say "$(cat "$run_root/negative-judgement.txt")"
    fail "the NEGATIVE CONTROL passed. The phone tapped the first row rather than the
   named target and every assertion still reported success, so this acceptance
   cannot detect a wrong selection and its green runs mean nothing."
  fi
  # "It failed" is NOT the claim. Any failure at all would satisfy that, so a
  # control built on it would always hold and would therefore say nothing.
  if ! judge_negative >>"$run_root/negative-judgement.txt" 2>&1; then
    say "$(cat "$run_root/negative-judgement.txt")"
    fail "the NEGATIVE CONTROL is INCONCLUSIVE. The round failed, but not with the
   evidence this control exists to produce: the phone must be shown to have
   listed three candidates, tapped the FIRST row, connected to a DECOY, and the
   browser must independently have seen that decoy dialled. A crash, a missing
   runner or a timeout fails a round without exercising the selection at all.
   Evidence kept under $run_root"
  fi
  say ""
  say "== NEGATIVE CONTROL held, on typed evidence. Tapping the first row instead of"
  say "   the named target made this round FAIL, and it failed for the reason the"
  say "   control exists to prove. Judgement:"
  say ""
  say "$(cat "$run_root/negative-judgement.txt")"
  say ""
  say "   (a held control is a successful run, so its run root is removed; set"
  say "    RELAYIUM_NEARBY_WEB_ARTIFACTS to keep the reports and logs.)"
  completed=1
  exit 0
fi

judge || fail "the round's own observations do not support a pass (evidence under $run_root)"

say ""
say "== Android ↔ the real Web, code-less room: three browser devices in one room,"
say "   the phone listed them all and connected — through the target row's OWN"
say "   button — to a device that was neither first in its model order nor first"
say "   on its screen; both decoys were never dialled, on the wire or on screen;"
say "   one link/1 session, a matching SAS, text both ways compared byte for byte,"
say "   and files both ways compared per file by name, path, size and SHA-256 —"
say "   a >192KiB body, a zero-byte file, and a nested non-ASCII path =="
say "   This run used its OWN throwaway server, never production."
say "   NOT physical-phone evidence, and NOT a claim about the direct path."
completed=1
