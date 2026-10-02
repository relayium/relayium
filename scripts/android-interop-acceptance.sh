#!/usr/bin/env bash
#
# **The Android app on a real emulator ↔ a real browser, over a real pairing
# code, on a real server.**
#
#   ./scripts/android-interop-acceptance.sh
#
# The cell nothing else in this repository fills for Android. `app/src/test`
# drives the controller against a fake transport, and the protocol module is
# checked against frozen vectors — both are precise about this implementation
# and neither can see a DISAGREEMENT between it and the shipped Web bundle.
# That is the only class of defect a second, independently written client
# introduces, and it is what this run exists to find.
#
# So there is no double on either side:
#
#   * a real Relayium server built from ./server, on an ephemeral loopback
#     port, serving the real built Web bundle;
#   * a real pairing code minted through /api/pair by an account this run
#     creates through the product's own HTTP API;
#   * the real debug APK on a real emulator, driven through its OWN
#     `MainActivity`/`TransferViewModel` (`InteropAcceptanceTest`), with real
#     OkHttp signalling, real native WebRTC and the real SAF stack;
#   * a real headless Chrome on the real bundle, joined to the same code;
#   * real WebRTC between them, on host candidates.
#
# ## What it proves, and in which direction
#
# Per round, in BOTH directions: the two clients reach one `link/1` workspace,
# and each receives the other's message and files with the bytes compared by
# SHA-256. The payloads are chosen to reach the boundaries that only appear
# between two implementations: a body that crosses the 192 KiB logical
# fragment boundary, a ZERO-byte file, a multi-file batch (so the global file
# sequence advances across entries), and — in the cancel rounds — a fresh batch
# under a LATER sequence after a cancel.
#
# The two directions are SEQUENCED and the sequence is part of the contract:
# the Android half waits for the browser's message before sending its own, and
# for the browser's batch before offering its own. What this proves is
# bidirectional transfer. It is deliberately NOT a claim about SIMULTANEOUS
# cross-initiation — nothing here holds both endpoints at a known point, so an
# unsequenced run would sample one arbitrary interleaving and report it as
# though the ordering space had been covered.
#
# ## Both role assignments, by schedule
#
# `linkRole` gives the smaller hub id the offer. With the hub's random ids each
# round was a coin flip, and on 2026-10-02 (run 36990034609, main 672e46a2f)
# ten functionally green rounds all left the browser RESPONDER — a 2^-10 event
# whose cause is still UNKNOWN; the ids it saw were not kept. So the run no
# longer samples: the loopback acceptance server's guarded deterministic hook
# (`RELAYIUM_ACCEPTANCE_PEER_IDS`, refused anywhere but here) hands out six
# globally distinct ids in accept order, and exactly three rounds PLAN the
# browser as responder, initiator, responder.
#
# A plan is only proof once it is observed, so every round checks it three
# independent ways (`scripts/test/android-interop-oracle.py`): the ids the
# server actually assigned (the browser's welcome and the rosters it saw), the
# role those real ids imply, and what the clients actually DID on the wire —
# the initiator offers, the responder asks. Ordering is made causal rather
# than hoped for: the Android half starts only after the browser's own welcome
# receipt names its planned id. And because the id list cycles, the server
# logs every accepted websocket with its own sequence number, and the run ends
# by requiring exactly six — a reconnect, an extra socket or a refused join
# anywhere is RED, never a retry.
#
# What the schedule does NOT cover: the SAS comparison happens only in round 1,
# with the browser responder. Initiator × SAS is not claimed. A failure in the
# initiator round is a finding about the clients — this lane never exercised
# that assignment in the 2026-10-02 run — to investigate, not to re-roll.
#
# ## What a green run does NOT prove
#
# It is an end-to-end path check, not a race detector, and not physical-device
# evidence: this runs on an AOSP emulator image with no Google Play services.
# A real phone has different radios, different SAF providers and different
# power management, and none of that is exercised here.
#
# ## Isolation
#
# `scripts/lib/local-acceptance.sh` owns every rule: ephemeral ports, one
# per-run temp root, tokens in the environment or a 0600 config file and never
# in argv, PID-exact cleanup with no `pkill`, `RELAYIUM_RELEASE_CHECK=false`,
# loopback-only STUN. Nothing here reaches the network or a real account, and
# the app under test asserts its OWN resolved backend origin before it joins
# anything — a reflective override that failed closed to production must fail
# this run's preflight, not send a disposable code to the real service.
set -Eeuo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$here/.." && pwd)"
# shellcheck source-path=SCRIPTDIR
# shellcheck source=lib/local-acceptance.sh
source "$here/lib/local-acceptance.sh"

# The deterministic schedule. Exactly three rounds, unconditionally: there is
# no round override, no statistical tail and no random fallback — every round
# after the third would only re-use the cycled ids, so a "cap" here would
# claim sampling that never happens. `scripts/test/role-coverage-cap-test.mjs`
# parses these three declarations and holds them to this shape.
#
# Two ids per round, browser first: the browser's socket is accepted before
# Android's (the welcome barrier below enforces it), so round r gives the
# browser entry 2r-1 and Android entry 2r. Distinct across the WHOLE list, so a
# receipt, a welcome or a roster from another round can never match this one.
max_rounds=3
acceptance_peer_ids="f111111111111111,0111111111111111,0222222222222222,f222222222222222,f333333333333333,0333333333333333"
planned_roles=(responder initiator responder)
IFS=, read -r -a peer_id_schedule <<<"$acceptance_peer_ids"
gradle_bin="${RELAYIUM_GRADLE:-$repo/apps/android/gradlew}"
adb="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-}}/platform-tools/adb"
serial="${ANDROID_SERIAL:-}"

app_id="com.relayium.android.debug"
test_pkg="$app_id.test"
runner="androidx.test.runner.AndroidJUnitRunner"

# Deliberately not ASCII-only and deliberately whitespace-significant: the
# message rides an AEAD-sealed text frame, so anything that trims, normalises
# or re-encodes surfaces here rather than as a vague size difference.
web_message="  web → android:\n\n\t你好 مرحبا 🌍 é\n   trailing   "
android_message="$(printf '%b' "android → web: 端到端 · 0123456789\n\tindented   ")"
post_cancel_message="$(printf '%b' "android → web: 取消之后仍然可用\t— still usable")"
web_message_text="$(printf '%b' "$web_message")"

# `am instrument` arguments are re-split by the DEVICE shell — `adb shell`
# concatenates argv into ONE remote command line, and host-side quoting does
# not survive that — so every payload with a tab, a newline or a non-ASCII
# character travels as hex and the instrumentation decodes it. Getting this
# wrong does not look like a quoting bug: it surfaces as an unrelated `am`
# usage error ("Invalid userId"), which is how it cost one whole run.
hex_of() { printf '%s' "$1" | od -An -tx1 | tr -d ' \n'; }
android_message_hex="$(hex_of "$android_message")"
post_cancel_hex="$(hex_of "$post_cancel_message")"

# The four Android-side payload sizes, and why each one is here.
#   199_000  crosses the 192 KiB (196_608 B) logical fragment boundary
#         0  a zero-byte file, which has no CHUNK at all and completes on DONE
#     1_024  an ordinary small file, so the batch is genuinely multi-entry
say_payloads() {
  say "-- payloads: a >192KiB body, a ZERO-byte file, a small file, and (in the"
  say "   cancel rounds) a fresh batch under a later sequence"
}

require_emulator() {
  [ -x "$adb" ] || fail "adb not found at $adb; set ANDROID_HOME or ANDROID_SDK_ROOT"
  local devices
  devices="$("$adb" devices | awk 'NR>1 && $2=="device" {print $1}')"
  [ -n "$devices" ] || fail "no attached device; start an emulator first (this run does not create one)"
  if [ -z "$serial" ]; then
    serial="$(printf '%s\n' "$devices" | head -1)"
  fi
  printf '%s\n' "$devices" | grep -qx "$serial" \
    || fail "ANDROID_SERIAL=$serial is not among the attached devices: $devices"
  say "-- driving $serial"
  # Google Play services would change which WebRTC and which providers are in
  # play. This lane is the AOSP image on purpose, and says so out loud.
  if "$adb" -s "$serial" shell pm list packages 2>/dev/null | grep -q 'com.google.android.gms'; then
    say "-- NOTE: this device has Google Play services; the CI image does not"
  fi
}

adbs() { "$adb" -s "$serial" "$@"; }

# Is this OWNED child still running? `kill -0` answers yes for any process that
# has exited but not been reaped (a zombie), so the process state is read
# instead. Only ever asked about PIDs this run started, and only between their
# start and their confirmed exit. A state query cannot prove the PID still
# names OUR child once the kernel has reused it; that is why every exited
# child's registry slot is retired at once (`retire_owned_child`), which
# narrows the reuse window rather than eliminating it.
owned_pid_running() {
  local state
  state="$(ps -o stat= -p "$1" 2>/dev/null || true)"
  state="${state#"${state%%[![:space:]]*}"}"
  [ -n "$state" ] && [ "${state#Z}" = "$state" ]
}

# Retire an EXITED owned child from the cleanup registry: blank exactly the one
# slot whose label AND pid both match, leave every other slot untouched, and
# fail if there is not exactly one. bash reaps its children as they exit, so
# from that moment the PID may be reused; the cleanup trap TERMs and KILLs
# every PID still registered, and a stale slot could reach an unrelated
# process. Called straight after `wait` collects the status — before any
# verdict, oracle, adb call, log read or next round.
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

# Collect an exited browser half's status and retire its slot, in that order,
# whatever the status was. The status is returned for the caller to judge.
reap_browser_half() {
  local status=0
  wait "$browser_pid" || status=$?
  retire_owned_child "browser-$round" "$browser_pid"
  browser_pid=""
  return "$status"
}

# The welcome barrier, shell side (`awaitOwnWelcome` in the browser half is the
# other). The Android half must not start until the browser's socket has been
# accepted and welcomed with its planned id, because the schedule hands ids
# out in ACCEPT order. Bounded by the same 90 seconds the browser gives the
# whole join, and cut short the moment the browser half exits: this is the one
# connection budget, observed from outside, not a second one.
await_browser_welcome() {
  local receipt="$1" waited=0
  local status
  while [ ! -e "$receipt" ]; do
    if ! owned_pid_running "$browser_pid"; then
      status=0
      reap_browser_half || status=$?
      fail "the browser half exited (status $status) before its welcome receipt: $(tail -40 "$run_root/browser-$round.log")"
    fi
    [ "$waited" -lt 360 ] \
      || fail "no welcome receipt from the browser within 90s: $(tail -40 "$run_root/browser-$round.log")"
    sleep 0.25
    waited=$((waited + 1))
  done
  python3 "$repo/scripts/test/android-interop-oracle.py" ready-receipt \
      "$receipt" "$round" "$nonce" "$browser_planned_id" \
    || fail "round $round's welcome receipt does not prove the planned barrier"
  say "-- browser welcomed as $browser_planned_id before the Android half starts"
}

# Stop THIS run's server before the final count, so nothing can append to its
# log after it has been read. TERM, a bounded wait for the process to actually
# exit, a reap, and only THEN its slot in the child registry is cleared — the
# cleanup trap must never signal a PID the kernel may already have handed to an
# unrelated process. A server that is already gone, will not exit, or cannot
# be found in the registry exactly once fails the run.
stop_owned_server() {
  local pid="${server_pid:-}" waited=0 i matched=0
  [ -n "$pid" ] || fail "no owned server PID to stop before the final count"
  owned_pid_running "$pid" \
    || fail "the owned server (pid $pid) was not running before the final count: $(tail -5 "$run_root/server.log")"
  kill -TERM "$pid" 2>/dev/null || fail "could not signal the owned server (pid $pid)"
  while owned_pid_running "$pid"; do
    [ "$waited" -lt 100 ] || fail "the owned server (pid $pid) did not exit within 10s of SIGTERM"
    sleep 0.1
    waited=$((waited + 1))
  done
  # The server's own exit status under TERM is not what this run judges; its
  # log is. bash reaps its own children as they exit, so this PID may be
  # reusable already: `wait` only collects the status, and the slot is cleared
  # straight away, before anything else in this run can signal it.
  wait "$pid" 2>/dev/null || true
  for i in "${!child_pids[@]}"; do
    if [ "${child_pids[$i]}" = "$pid" ] && [ "${child_labels[$i]}" = server ]; then
      child_pids[i]=""
      matched=$((matched + 1))
    fi
  done
  [ "$matched" -eq 1 ] || fail "the owned server (pid $pid) matched $matched registry slots, not one"
  say "-- stopped this run's server (pid $pid) before the final count"
}

acceptance_begin
say_payloads

say "== building the local server =="
( cd "$repo/server" && go build -o "$run_root/relayium-server" . ) \
  || fail "the local server failed to build"

# `vite build` rather than `npm run build`: the latter runs `gen-pages.mjs`,
# which REWRITES committed static pages, so a run of this script would leave
# the working tree dirty in files it has nothing to do with.
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
[ -f "$app_apk" ] || fail "no debug APK at $app_apk"
[ -f "$test_apk" ] || fail "no instrumentation APK at $test_apk"

require_emulator
say "== installing =="
adbs install -r -t "$app_apk" >/dev/null || fail "could not install the app"
adbs install -r -t "$test_apk" >/dev/null || fail "could not install the instrumentation"
# App data survives a reinstall, so a previous run's disposable tree would
# otherwise still be there for round 1.
adbs shell pm clear "$app_id" >/dev/null 2>&1 || true

acceptance_start_server
acceptance_create_account

# The emulator reaches the host's loopback as 10.0.2.2. The app's own
# `Backend.resolve` PARSES this and accepts only an exact local origin; the
# instrumentation asserts the resolved value before it joins anything.
emulator_origin="http://10.0.2.2:$server_port"
adbs shell setprop debug.relayium.backend "$emulator_origin" \
  || fail "could not point the app at $emulator_origin"
[ "$(adbs shell getprop debug.relayium.backend | tr -d '\r')" = "$emulator_origin" ] \
  || fail "the backend property did not take"
say "-- the app under test is pointed at $emulator_origin"

curl -sf --max-time 10 "$origin/cross-network" | grep -q '<div id="app"' \
  || fail "the server is not serving the built Web app at $origin/cross-network"
say "-- the built Web bundle is served from $origin"

# The bearer token goes in a 0600 curl config, never in argv: `ps` is readable
# by every process on a CI runner, and an acceptance that leaked its own token
# would be teaching the wrong pattern regardless of the account being
# disposable.
umask 077
printf 'header = "Authorization: Bearer %s"\n' "$account_token" >"$run_root/auth.conf"

mint_code() {
  local body
  body="$(curl -sf --max-time 20 -X POST "$origin/api/pair" \
            --config "$run_root/auth.conf" -H 'Content-Type: application/json' -d '{}')" \
    || return 1
  printf '%s' "$body" | python3 -c 'import json,sys;print(json.load(sys.stdin).get("code",""))'
}

seen_initiator=0
seen_responder=0
compared_sas=0
round=0

while [ "$round" -lt "$max_rounds" ]; do
  round=$((round + 1))

  # **Paced against the server's own join budget, which is production and must
  # not be relaxed for a test.** `wsJoinPerIPPerMinute` is 5, and one round
  # spends two `/ws?code=` joins from this one loopback address. A third round
  # inside the same minute is refused, and the refusal reads exactly like the
  # disagreement this run exists to detect.
  if [ "$round" -gt 1 ]; then
    say "-- waiting out the server's per-IP join budget before round $round"
    sleep 65
  fi

  # Round shape. Round 1 turns advanced verification ON, because that is the
  # only configuration in which the browser renders the six digits at all and
  # therefore the only place the two clients' SAS can be compared. Rounds 2 and
  # 3 exercise the two cancels on the shipped default path. EVERY round sends
  # two inbound batches and (outside the send-cancel round) two outbound ones,
  # so the global file sequence advances across batches on one link.
  verify_mode=default
  cancel_mode=none
  case "$round" in
    1) verify_mode=on ;;
    2) cancel_mode=receive ;;
    3) cancel_mode=send ;;
  esac

  # This round's plan: two consecutive schedule entries, browser first.
  browser_planned_id="${peer_id_schedule[$((2 * round - 2))]:-}"
  android_planned_id="${peer_id_schedule[$((2 * round - 1))]:-}"
  planned_role="${planned_roles[$((round - 1))]:-}"
  [ -n "$browser_planned_id" ] && [ -n "$android_planned_id" ] && [ -n "$planned_role" ] \
    || fail "the schedule has no plan for round $round"

  say ""
  say "== round $round: one code, one emulator, one browser (verify=$verify_mode, cancel=$cancel_mode) =="
  say "-- planned: browser $planned_role (browser $browser_planned_id, Android $android_planned_id)"

  code="$(mint_code)" || fail "could not mint a pairing code"
  [ -n "$code" ] || fail "the server minted no pairing code"
  say "-- minted $code"

  # ── the payload descriptors ─────────────────────────────────────────────
  #
  # `{name, size, seed}`, never the bytes themselves. The browser half and the
  # instrumentation each generate them from the same deterministic rule, and
  # the comparison is by digest — so a drift between the three implementations
  # is a failed round rather than a silent pass.
  #
  # The bytes are NOT passed on a command line. A ~400 KB hex argument works on
  # this developer's macOS and is `E2BIG` on the hosted Linux runner, whose
  # `MAX_ARG_STRLEN` caps one argument at 128 KiB: a lane that could pass here
  # and never there.
  big_size=199000                     # crosses the 192 KiB (196_608 B) boundary
  big_seed="$round"
  small_size=1024
  small_seed=$((round + 7))
  second_size=4096
  second_seed=$((round + 21))

  # The cancelled batch must be LARGER than one FLOW_WINDOW (8 MiB) so its
  # final frames cannot be on the wire before the cancel; the browser then
  # holds its first durable write and the sender stalls inside the window with
  # the batch nowhere near complete. Every other round sends a normal
  # boundary-crossing payload.
  if [ "$cancel_mode" = "send" ]; then
    android_size=$((8 * 1024 * 1024 + 4096))
  else
    android_size=$((196608 + 1024 * round))
  fi
  android_seed=$((100 + round))
  android_name="android-to-web-$round.bin"

  plan="$run_root/plan-$round.json"
  expect="$run_root/expect-$round.json"
  browser_out="$run_root/browser-$round.json"
  android_out="$run_root/android-$round.json"

  # Both descriptors are generated by ONE program from ONE set of inputs, so
  # what the browser is told to send and what the comparison demands cannot
  # drift apart. A barrier or an expectation that could be satisfied by bytes
  # the comparison would reject is worse than none: it reports agreement it
  # never waited for.
  RELAYIUM_WEB_MESSAGE="$web_message_text" \
  RELAYIUM_ANDROID_MESSAGE="$android_message" \
  RELAYIUM_POST_CANCEL="$post_cancel_message" \
  python3 - "$plan" "$expect" "$verify_mode" "$cancel_mode" "$emulator_origin" \
      "$big_size" "$big_seed" "$small_size" "$small_seed" \
      "$second_size" "$second_seed" "$android_size" "$android_seed" \
      "$android_name" "$round" "$browser_planned_id" "$android_planned_id" "$planned_role" \
      <<'PLAN' || fail "could not build round $round's descriptors"
import hashlib, json, os, sys

(plan_path, expect_path, verify, cancel, origin,
 big_size, big_seed, small_size, small_seed,
 second_size, second_seed, android_size, android_seed,
 android_name, rnd, browser_planned_id, android_planned_id, planned_role) = sys.argv[1:]

ints = lambda *v: [int(x) for x in v]
big_size, big_seed, small_size, small_seed, second_size, second_seed, android_size, android_seed = \
    ints(big_size, big_seed, small_size, small_seed, second_size, second_seed, android_size, android_seed)

SEND_AGAIN = "relayium-e2e:send-again"
# The send-cancel gate's release request, which the browser must SEE (Android
# sends it after cancelling, so the browser can release its held write).
CANCEL_REQUESTED = "relayium-e2e:cancel-now"
web_message = os.environ["RELAYIUM_WEB_MESSAGE"]
android_message = os.environ["RELAYIUM_ANDROID_MESSAGE"]
post_cancel = os.environ["RELAYIUM_POST_CANCEL"]


def body(size, seed):
    return bytes(((i * 31 + seed) & 0xff) for i in range(size))


def descriptor(name, size, seed):
    return {"name": name, "size": size, "seed": seed}


def expected(name, size, seed):
    return {"name": name, "size": size,
            "sha256": hashlib.sha256(body(size, seed)).hexdigest()}


# The browser's FIRST batch is multi-entry on purpose — one entry never
# exercises the global file sequence ACROSS entries — and carries both
# boundary payloads. Its second batch is what a cancelled receive retries
# with, and in an ordinary round is simply a later batch on the same link.
first_batch = [
    descriptor("web-big-%s.bin" % rnd, big_size, big_seed),
    descriptor("web-zero-%s.bin" % rnd, 0, 0),
    descriptor("web-small-%s.bin" % rnd, small_size, small_seed),
]
second_batch = [descriptor("web-second-%s.bin" % rnd, second_size, second_seed)]

first_expected = [expected(f["name"], f["size"], f["seed"]) for f in first_batch]
second_expected = [expected(f["name"], f["size"], f["seed"]) for f in second_batch]

if cancel == "receive":
    # The first batch is CANCELLED mid-flight: Android must end up with none of
    # it, and the retry — the second batch — must arrive whole.
    web_sent = second_expected
    android_must_not_save = [f["name"] for f in first_batch if f["size"] > 0]
else:
    web_sent = first_expected + second_expected
    android_must_not_save = []

if cancel == "send":
    # Android cancels a >FLOW_WINDOW batch that the browser is HOLDING, then
    # retries with a fresh small file on the same link. The browser must
    # complete the RETRY; the cancelled name may remain only as a strictly
    # smaller PARTIAL (mixed-file-session closes the sink on abort), never at
    # its full size or digest.
    android_sent = [expected("retry-" + android_name, 2048, android_seed + 5)]
    browser_must_not_save = [android_name]
    expect_messages = [android_message, SEND_AGAIN, CANCEL_REQUESTED, post_cancel]
else:
    # A MULTI-ENTRY batch — a >192KiB body, a ZERO-byte file and a small one —
    # plus a repeated batch, so the global file sequence advances across
    # ENTRIES and across BATCHES. The browser saves the multi-file batch
    # through its directory path, observed per file by the ledger.
    android_sent = [
        expected(android_name, android_size, android_seed),
        expected("zero-" + android_name, 0, 0),
        expected("small-" + android_name, 3072, android_seed + 2),
        expected("again-" + android_name, 2048, android_seed + 1),
    ]
    browser_must_not_save = []
    expect_messages = [android_message, SEND_AGAIN, post_cancel]

json.dump({
    "batches": [first_batch, second_batch],
    "expectMessages": expect_messages,
    "expectSaved": [f["name"] for f in android_sent],
    "forbidSaved": browser_must_not_save,
}, open(plan_path, "w"), ensure_ascii=False, indent=2)

json.dump({
    "origin": origin,
    "verify": verify,
    "cancel": cancel,
    "webMessage": web_message,
    "androidMessages": [android_message, post_cancel],
    "androidSent": android_sent,
    "webSent": web_sent,
    "androidMustNotSave": android_must_not_save,
    "browserMustNotSave": browser_must_not_save,
    # The cancelled file's FULL size, so the oracle can require the browser's
    # leftover to be a strictly-smaller PARTIAL rather than a completed save.
    "cancelledFullSize": (android_size if cancel == "send" else 0),
    # The round's PLAN, from the one schedule above. The oracle requires the
    # assigned ids, the role they imply and the wire's offer direction to
    # agree with it; it never takes the browser's own role field as proof.
    "round": rnd,
    "plannedRole": planned_role,
    "expectedBrowserId": browser_planned_id,
    "expectedAndroidId": android_planned_id,
}, open(expect_path, "w"), ensure_ascii=False, indent=2)
PLAN

  # A fresh nonce and a fresh receipt name per round: a receipt from another
  # round, or one left behind, can never satisfy this one.
  nonce="$(od -An -N16 -tx1 /dev/urandom | tr -d ' \n')"
  [ "${#nonce}" -eq 32 ] || fail "could not draw round $round's barrier nonce"
  receipt="$run_root/welcome-$round-$nonce.json"
  [ ! -e "$receipt" ] || fail "round $round's welcome receipt exists before its browser started"

  # ── the browser half ────────────────────────────────────────────────────
  #
  # `exec`, so the PID registered below IS the Node process. Without it the
  # backgrounded subshell is what `$!` names: cleanup TERMs the subshell, Node
  # never sees a signal, and Node plus its Chrome outlive the run with PPID 1
  # — which is exactly how one pilot leaked a browser for 54 seconds. Node's
  # own handlers (registered before anything is spawned) then close the Chrome
  # it owns, whether the signal lands before or after CDP came up.
  (
    cd "$repo/web" && exec node e2e/android-interop.mjs \
      --origin "$origin" --code "$code" --out "$browser_out" \
      --verify "$verify_mode" --message "$web_message_text" --plan "$plan" \
      --round "$round" --nonce "$nonce" --ready "$receipt" --expect-self "$browser_planned_id"
  ) >"$run_root/browser-$round.log" 2>&1 &
  browser_pid=$!
  register_child "browser-$round" "$browser_pid"

  await_browser_welcome "$receipt"

  # ── the Android half ────────────────────────────────────────────────────
  #
  # The report is removed first and required to come back with its own
  # success-only `complete` flag: the instrumentation writes its observations
  # from a `finally`, so a FAILED round also produces a file, and a run that
  # accepted the file's existence would read a failure as a pass.
  # **Every round starts from an empty app.**
  #
  # The disposable documents tree lives in the app's own storage, and app data
  # SURVIVES a reinstall — so without this a round inherits the previous
  # round's saved files under the very same names. That is not a tidiness
  # point: the destination would already contain `web-big-N.bin` before the
  # transfer began, so "the file arrived" and "a stale copy was already there"
  # would be indistinguishable, and the cancelled-receive leak assertion would
  # be asserting about the wrong run. It cost one full run to find.
  #
  # `pm clear` before `am instrument`, never during: the backend override is a
  # system property and is unaffected.
  adbs shell pm clear "$app_id" >/dev/null 2>&1 \
    || fail "could not reset the app's data before round $round"

  # The report lands in the app's own INTERNAL files directory and is read
  # back with `run-as`. `/sdcard/Android/data/<pkg>/files` is EACCES on this
  # API level even for the owning uid, and the failure surfaces inside the
  # instrumentation rather than here.
  device_out="interop-$round.json"

  set +e
  adbs shell am instrument -w -r \
    -e class com.relayium.android.InteropAcceptanceTest \
    -e relayium.origin "$emulator_origin" \
    -e relayium.code "$code" \
    -e relayium.out "$device_out" \
    -e relayium.messageHex "$android_message_hex" \
    -e relayium.postCancelHex "$post_cancel_hex" \
    -e relayium.sendName "$android_name" \
    -e relayium.sendSize "$android_size" \
    -e relayium.sendSeed "$android_seed" \
    -e relayium.textRole accept \
    -e relayium.cancel "$cancel_mode" \
    "$test_pkg/$runner" >"$run_root/instrument-$round.log" 2>&1
  instrument_status=$?
  set -e

  # FOUR independent conditions, because each one alone has a way of being
  # true over a failed run:
  #
  #   * `adb`'s own exit — a transport error never reaches the log at all;
  #   * `INSTRUMENTATION_CODE: -1` — the harness ran to completion (a crash or
  #     a timeout gives a different code, or none);
  #   * no per-test FAILURE or ERROR status — `INSTRUMENTATION_CODE: -1` is
  #     reported for a run whose test FAILED, so this is the one that
  #     distinguishes them;
  #   * the report's own `complete` flag, written last and only on success.
  [ "$instrument_status" -eq 0 ] \
    || fail "adb could not run the Android half (exit $instrument_status): $(tail -20 "$run_root/instrument-$round.log")"
  grep -q '^INSTRUMENTATION_CODE: -1$' "$run_root/instrument-$round.log" \
    || fail "the Android half did not run to completion: $(tail -40 "$run_root/instrument-$round.log")"
  if grep -qE '^INSTRUMENTATION_STATUS_CODE: (-1|-2)$' "$run_root/instrument-$round.log"; then
    fail "the Android half FAILED: $(sed -n '/INSTRUMENTATION_STATUS: stack=/,/^INSTRUMENTATION_STATUS_CODE/p' "$run_root/instrument-$round.log" | head -40)"
  fi

  # Status first, registry second, verdict third: a failed browser half is
  # still a FAILED round, but its slot is retired before the failure is
  # reported, so the cleanup trap that `fail` triggers cannot signal its PID.
  browser_status=0
  reap_browser_half || browser_status=$?
  [ "$browser_status" -eq 0 ] \
    || fail "the browser half failed (exit $browser_status): $(tail -40 "$run_root/browser-$round.log")"
  [ -f "$browser_out" ] || fail "the browser half wrote no observation"

  adbs exec-out run-as "$app_id" cat "files/$device_out" >"$android_out" 2>/dev/null \
    || fail "the Android half wrote no observation at files/$device_out"
  [ -s "$android_out" ] || fail "the Android half's observation is empty"
  python3 -c 'import json,sys; sys.exit(0 if json.load(open(sys.argv[1])).get("complete") else 1)' \
    "$android_out" \
    || fail "the Android half's report is not from a completed round: $(head -c 2000 "$android_out")"

  # ── the comparison, made by neither half ────────────────────────────────
  python3 "$repo/scripts/test/android-interop-oracle.py" \
    "$browser_out" "$android_out" "$expect" \
    || fail "round $round did not agree"

  # Read the two fields from the observation FILE, never by substituting its
  # whole text into argv: a normal report is ~400 KB and a send-cancel round's
  # partial pushes it past the Linux 128 KiB single-argument limit (and macOS
  # ARG_MAX), so `json_field "$(cat …)"` would fail as an unrelated `E2BIG`.
  # The small `/api/*` responses stay on `json_field`; only these two grow.
  read -r role has_sas < <(python3 -c '
import json, sys
d = json.load(open(sys.argv[1]))
print(d.get("role", ""), "1" if d.get("sas") else "0")
' "$browser_out") || fail "could not read the browser observation"
  [ "$has_sas" = "1" ] && compared_sas=1
  case "$role" in
    initiator) seen_initiator=1 ;;
    responder) seen_responder=1 ;;
    *) fail "the browser could not name its role" ;;
  esac

  adbs shell am force-stop "$app_id" >/dev/null 2>&1 || true
  say "-- round $round passed (browser was $role, as planned)"
done

# All three rounds, never fewer: each one carries a scenario (SAS, receive
# cancel, send cancel) as well as a role.
[ "$round" -eq 3 ] || fail "ran $round rounds, not the scheduled three"

[ "$seen_initiator" = "1" ] \
  || fail "never observed the browser as INITIATOR in $round rounds; half the role space is unproved"
[ "$seen_responder" = "1" ] \
  || fail "never observed the browser as RESPONDER in $round rounds; half the role space is unproved"
[ "$compared_sas" = "1" ] \
  || fail "no round compared the two clients' SAS digits; the one cell nothing else covers is unproved"

# ── every accepted websocket, counted ────────────────────────────────────
#
# Only once every owned client is gone: each round already waited for its
# browser half, and the app is stopped (and confirmed stopped) here. Then the
# server itself is stopped and reaped, so the log read below is COMPLETE — a
# count taken while anything could still connect would miss exactly the late
# reconnect it exists to catch. Read before `completed=1`: on success the run
# root, log included, is deleted by the cleanup trap.
adbs shell am force-stop "$app_id" >/dev/null 2>&1 \
  || fail "could not stop the app before the final count"
[ -z "$(adbs shell pidof "$app_id" 2>/dev/null | tr -d '\r')" ] \
  || fail "the app is still running after force-stop; the final count could miss its reconnect"
stop_owned_server
python3 "$repo/scripts/test/android-interop-oracle.py" peer-id-log \
    "$run_root/server.log" "$acceptance_peer_ids" \
  || fail "the server did not accept exactly the scheduled websockets"

assert_run_was_local

say ""
say "== Android emulator ↔ real browser: both role assignments by schedule (observed on the wire), text and files, both directions,"
say "   a >192KiB body, a zero-byte file, a multi-file batch, and both cancels with a fresh retry =="
say "   NOT physical-device evidence: this is an AOSP emulator image with no Google Play services."
completed=1
