#!/usr/bin/env bash
#
# **The Android Device Inbox, end to end, against a real macOS endpoint.**
#
# Runs against an Android RUNTIME — emulator or device. The suite does not
# distinguish them and must not be read as physical-hardware evidence.
#
#   ANDROID_SERIAL=emulator-5554 ./scripts/android-host-inbox-acceptance.sh
#
# This is the LIVE half of the Android host evidence. `android-host-acceptance.sh`
# proves the shared host's own rules offline — five destinations, the picker
# lease, the share ingress — and states plainly that it does not prove a real
# external share, a real permission journey or a real SAF round trip. This run is
# where the Inbox actually crosses the wire.
#
# One `MainActivity`, driven by a person's taps. One `LocalTransferPeer --role
# inbox-endpoint`, which composes the shipped `InboxController`, `InboxSendModel`
# and `AccountSession` over a durable state root. One throwaway server on
# loopback. Both sides are asked what they hold, and the two answers are compared.
#
# ## What it proves
#
#   * a real sign-in through the Account FORM — not an injected bearer — reaching
#     Inbox enrolment, a device list that names the Mac and excludes this device,
#     and a foreground worker that is actually listening;
#   * Android → Mac: a message whose leading and trailing whitespace is
#     load-bearing, and two real `DocumentsUI` picks — an empty file and one past
#     the 192 KiB `STORE_CHUNK_SIZE`, with a Unicode name;
#   * Mac → Android: the `android-parity` batch, compared by relative path, size
#     and SHA-256 against an independent walk of what actually landed on disk;
#   * AUTO receives while the person is on Account, Cloud or Nearby — the claim
#     is app-wide, not a property of the Inbox tab;
#   * a real Home key withdraws receiving and coming back restores the chosen
#     policy, with the held delivery landing rather than vanishing;
#   * ASK prompts and honours BOTH answers; OFF refuses and says so to the other
#     device instead of going quiet;
#   * history, unread, mark-read-by-reading, the stored body, deletion;
#   * a real SAF export that keeps the tree, granted to a genuinely separate-UID
#     reader;
#   * a cancelled send that does not claim success on either side, and a restart
#     that neither loses history nor resurrects a deleted entry.
#
# ## One `am instrument` invocation per leg
#
# `am instrument` exits 0 almost unconditionally — including when the app crashed
# and when nothing ran at all — so every leg is checked by
# `scripts/lib/instrumentation-result.sh`, which requires a specific number of
# tests to have been OBSERVED to finish. Running one method per invocation makes
# that number exactly 1, and makes each leg's barrier real: the fixture is
# re-provisioned, the app starts clean, and the test waits for the product's own
# `LISTENING` before the Mac is asked to send.
#
# The ORDER below is a dependency order, not a preference. Later legs read the
# history earlier ones created, and `identity-switch` is last because it
# deliberately destroys the first account's state.
#
# ## Prerequisite: a disposable device
#
# This run RESETS the debug application's data once, after installing and before
# provisioning anything, because `install -r` preserves it and a restored session
# from an earlier run points at a server that no longer exists. Run it only
# against a dedicated acceptance emulator whose contents are disposable. The
# release application id is never named and never touched.
#
# ## Secrets
#
# The account password and the peer's control bearer never appear in argv, in an
# environment dump, or in a log. They are written into the app's own `filesDir`
# over `run-as … cat`, with the bytes arriving on STDIN and the remote command a
# FIXED quoted string. `LiveFixture` deletes the file as it reads it, and this
# script removes it again on every exit path. The whitespace-significant message
# travels base64 because `LiveFixture` trims values as it parses.
#
# Nothing here prints a server log or an account log to stdout. Per-leg evidence
# is validated JSON under the run's output directory.
set -Eeuo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$here/.." && pwd)"
# shellcheck source=lib/local-acceptance.sh
. "$here/lib/local-acceptance.sh"

adb="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-}}/platform-tools/adb"
serial="${ANDROID_SERIAL:-}"
gradle_bin="${RELAYIUM_GRADLE:-$repo/apps/android/gradlew}"
app_id="com.relayium.android.debug"
test_pkg="$app_id.test"
runner="androidx.test.runner.AndroidJUnitRunner"
test_class="com.relayium.android.integration.HostInboxLiveTest"
reader_pkg="com.relayium.acceptance.reader"
out_dir="${RELAYIUM_HOST_INBOX_OUT:-$repo/apps/android/build/host-inbox-acceptance}"

# Past STORE_CHUNK_SIZE (192 KiB = 196_608), so a delivery spans two chunks.
multiframe_bytes=307200

# The legs, in dependency order. One method per invocation, one passing test each.
legs="
signsInThroughTheAccountFormAndRegistersTheInbox
sendsWhitespaceSignificantUnicodeTextToTheAppleTarget
sendsAnEmptyAndAMultiframeFileThroughTheRealPicker
receivesTheAndroidParityBatchWhileForeground
receivesWhileForegroundOnAccountCloudAndNearbyTabs
homeWithdrawsReceivingAndComingBackRestoresThePolicy
askHoldsTheDeliveryUntilThePersonAnswers
offRefusesNewDeliveryAndSaysSoToTheOtherDevice
historyUnreadMarkReadAndTheMessageBody
exportsThroughRealSafKeepingNestedPaths
opensAndSharesToTheExternalReader
deletionRemovesTheEntryAndItsBody
aCancelledSendDoesNotClaimSuccess
historySurvivesARestart
aNewIdentityCancelsTheOldAccountsWork
"

# **Run a PREFIX of the legs, for a cheap first pass.**
#
# `RELAYIUM_HOST_INBOX_LEGS=1` runs only the sign-in leg — the one that proves a
# real account form reaches real Inbox enrolment — and stops. It is a prefix and
# not a selection on purpose: the legs are a dependency order, and running leg 7
# without the history legs 2-6 created would assert against a device that never
# received anything.
#
# Empty or unset runs all of them.
leg_limit="${RELAYIUM_HOST_INBOX_LEGS:-}"
case "$leg_limit" in
  ''|*[!0-9]*) [ -z "$leg_limit" ] || fail "RELAYIUM_HOST_INBOX_LEGS must be a count" ;;
esac

[ -x "$adb" ] || fail "adb not found at $adb; set ANDROID_HOME or ANDROID_SDK_ROOT"
devices="$("$adb" devices | awk 'NR>1 && $2=="device" {print $1}')"
[ -n "$serial" ] || serial="$(printf '%s\n' "$devices" | head -1)"
[ -n "$serial" ] || fail "no device is attached"
printf '%s\n' "$devices" | grep -qx "$serial" || fail "ANDROID_SERIAL=$serial not attached ($devices)"
adbs() { "$adb" -s "$serial" "$@"; }

mkdir -p "$out_dir"

# ── device state this run changes, read BEFORE anything is touched ───────────
#
# Read first, and an unreadable answer aborts before a single setting moves: a
# harness that mutated state it could not put back is worse than one that
# refused to start.
orig_backend="$(adbs shell getprop debug.relayium.backend | tr -d '\r' || true)"

# Runs on EVERY exit path, including a failure part-way through. The fixture
# removal is not optional: a leg that failed before `LiveFixture.load` consumed
# it would otherwise leave an account password in app storage for whoever picks
# the device up next.
acceptance_extra_cleanup() {
  adbs exec-out "run-as $app_id sh -c 'rm -f files/live-fixture.properties'" \
    >/dev/null 2>&1 || true
  if [ -n "$orig_backend" ]; then
    adbs shell setprop debug.relayium.backend "$orig_backend" >/dev/null 2>&1 || true
  else
    adbs shell setprop debug.relayium.backend '""' >/dev/null 2>&1 || true
  fi
  adbs shell am force-stop "$app_id" >/dev/null 2>&1 || true
  adbs shell am force-stop "$reader_pkg" >/dev/null 2>&1 || true
}

acceptance_begin
acceptance_build "$repo/server" "$repo/apps/RelayiumKit"
acceptance_start_server

# The emulator reaches the host's loopback as 10.0.2.2. `Backend.resolve` PARSES
# this and accepts only an exact local origin, so a run that pointed the app
# anywhere else fails in the app rather than reaching a real service.
server_port="${origin##*:}"
android_origin="http://10.0.2.2:$server_port"

# ── the peer binary, identified honestly ─────────────────────────────────────
#
# This lane added the `android-parity` case to `EndpointBatch.make`, so a
# previously built binary CANNOT serve it: it would fall through to `default` and
# send the `primary` batch, whose largest file is 96_000 bytes — under one chunk
# — and the multiframe assertion would be made against a delivery that never
# crossed a boundary. That is exactly the failure a "reused the binary we had"
# note would hide, so the identity is stated rather than assumed.
# `acceptance_build` compiled it from THIS worktree a moment ago, so there is no
# prebuilt to mistake for it — but the label is still checked, because "we built
# it" and "the build contains the case" are different claims.
say "== the peer binary =="
[ -x "$peer_binary" ] || fail "no peer binary at $peer_binary"
peer_sha="$(shasum -a 256 "$peer_binary" | awk '{print $1}')"
say "-- peer binary: built from source this run at $peer_binary"
say "-- peer sha256: $peer_sha"
# A STATIC fence, before a single byte is sent: the label must be present in the
# binary that is about to run. Cheap, and it fails the run at the top rather
# than three legs later as a confusing size mismatch.
if LC_ALL=C grep -qa 'android-parity' "$peer_binary"; then
  say "-- the binary carries the android-parity label"
else
  fail "the peer binary does not carry 'android-parity'; it predates this lane's fixture case"
fi

# ── one account, two device rows ─────────────────────────────────────────────
#
# A delivery is sealed to ONE device's current public key and a sender is removed
# from its own target list, so a run with one bearer would authenticate both
# sides as the same row and correctly report that this account has nobody to send
# to. Separate `native/login` calls with different `deviceName`s are what produce
# separate rows — which is what a Mac and a phone signed in to one account are.
#
# The Android side does NOT use a minted bearer. It types the password into the
# real Account form, which is what exercises the host's credential adoption.
apple_name="acceptance-mac-$run_tag"
acceptance_extra_devices=("$apple_name")
acceptance_publish_password=1
acceptance_create_account
apple_token="${account_device_tokens[0]}"
[ -n "$apple_token" ] || fail "the device login answered no bearer"
[ -n "${account_password:-}" ] || fail "the account password was not published to this run"

# The second identity, for the account-switch leg. A separate account, not a
# second device on the first: the assertion is that a NEW identity cancels the
# old one's work, and two rows on one account share a history by design.
second_email="acceptance-second-${run_tag}@example.invalid"
second_password="$(od -An -tx1 -N24 /dev/urandom | tr -d ' \n')"
acceptance_register_second_account() {
  # Every token the log ALREADY holds, before this registration exists. The
  # server writes its log asynchronously, so reading "the last token" straight
  # after the POST can legitimately return the FIRST account's — and verifying
  # with it would confirm the wrong registration and then fail much later, as a
  # sign-in refusal for an account that was never verified.
  local before token
  before="$(grep -o 'verify-email?token=[0-9a-f]*' "$run_root/server.log" | sort -u || true)"
  printf '{"email":"%s","password":"%s"}' "$second_email" "$second_password" \
    >"$run_root/register2.json"
  curl -sf --max-time 20 -X POST "$origin/api/auth/register" \
    -H 'Content-Type: application/json' --data-binary "@$run_root/register2.json" >/dev/null \
    || fail "could not register the second acceptance account"
  local waited=0
  token=""
  while [ "$waited" -lt 100 ]; do
    token="$(grep -o 'verify-email?token=[0-9a-f]*' "$run_root/server.log" | sort -u \
      | grep -vxF "${before:-__none__}" | tail -1 | cut -d= -f2 || true)"
    [ -n "$token" ] && break
    sleep 0.2
    waited=$((waited + 1))
  done
  [ -n "$token" ] || fail "the server logged no NEW verification token for the second account"
  printf '{"token":"%s","password":"%s"}' "$token" "$second_password" >"$run_root/verify2.json"
  curl -sf --max-time 20 -X POST "$origin/api/auth/email/verify" \
    -H 'Content-Type: application/json' --data-binary "@$run_root/verify2.json" >/dev/null \
    || fail "could not verify the second acceptance account"
  # Both bodies carried a password. They go as soon as they have been used.
  rm -f "$run_root/register2.json" "$run_root/verify2.json"
}
acceptance_register_second_account
say "-- two accounts exist; the Mac holds one device row on the first"

# ── the macOS endpoint ───────────────────────────────────────────────────────
peer_env=("RELAYIUM_ACCEPTANCE_ACCOUNT_TOKEN=$apple_token")
start_peer apple-endpoint inbox-endpoint --state-root "$run_root/apple-endpoint"
apple_port="$peer_port"
assert_control_api_is_guarded "$apple_port"
control "$apple_port" POST /start >/dev/null
peer_url="http://10.0.2.2:$apple_port"
say "-- the macOS endpoint is up on $apple_port, reached from the device as $peer_url"

# ── the app ──────────────────────────────────────────────────────────────────
say "== building and installing =="
( cd "$repo/apps/android" && JAVA_HOME="${JAVA_HOME:-}" "$gradle_bin" \
    :app:assembleDebug :app:assembleDebugAndroidTest ) \
  >"$run_root/gradle.log" 2>&1 \
  || fail "the app did not build; see $run_root/gradle.log"
app_apk="$repo/apps/android/app/build/outputs/apk/debug/app-debug.apk"
test_apk="$repo/apps/android/app/build/outputs/apk/androidTest/debug/app-debug-androidTest.apk"
[ -f "$app_apk" ] || fail "no app APK at $app_apk"
[ -f "$test_apk" ] || fail "no instrumentation APK at $test_apk"
adbs install -r -g -t "$app_apk" >/dev/null || fail "could not install the app"
adbs install -r -t "$test_apk" >/dev/null || fail "could not install the instrumentation"

# The separate-UID reader, for the real cross-app grant. Root owns this fixture;
# this run installs it and reads its report, and never reimplements it.
reader_apk="${RELAYIUM_EXTERNAL_READER_APK:-}"
if [ -n "$reader_apk" ] && [ -f "$reader_apk" ]; then
  adbs install -r -t "$reader_apk" >/dev/null || fail "could not install the external reader"
  say "-- the separate-UID reader is installed"
else
  fail "set RELAYIUM_EXTERNAL_READER_APK to root's private-inbox-reader APK"
fi

# ── one reset, for the whole run ─────────────────────────────────────────────
#
# **`install -r` PRESERVES application data**, deliberately — it is an upgrade,
# not a reinstall. So a device that ran this suite before comes up holding the
# previous run's credential in the Keystore, and the app restores that session on
# launch. The Account tab then renders a signed-in view with no form on it, and
# the first leg fails looking for a text field that is correctly absent: the
# observed error was "no SetText nodes" before a single character was typed.
#
# The credential is also USELESS by then — each run starts its own throwaway
# server on a fresh ephemeral port — so the restored session is not merely stale,
# it points at a backend that no longer exists.
#
# ## Once per run, and not per leg
#
# The legs are a dependency chain: later ones read the history earlier ones
# created, and a clear between them would destroy the very thing
# `historySurvivesARestart` exists to require back. So this happens exactly once,
# after the install and before the first fixture is provisioned.
#
# ## Only ever the disposable debug package
#
# `pm clear` is destructive, so the target is checked rather than trusted. This
# suite is for a dedicated acceptance emulator whose entire contents are
# synthetic; it must not be pointed at a device holding data anyone wants. The
# release application id is never named here and is never touched.
case "$app_id" in
  *.debug) : ;;
  *) fail "refusing to clear '$app_id': this step only ever touches the debug package" ;;
esac
say "== resetting the disposable debug app (once, for the whole run) =="
adbs shell pm clear "$app_id" >/dev/null || fail "could not reset $app_id"
# `pm clear` resets runtime permissions along with the data. Nothing these legs
# drive needs one — the Inbox reads and writes through the system picker, and the
# camera belongs to the scanner suite — but the state is restored to what
# `install -g` had granted so a later leg cannot be surprised by it.
adbs shell pm grant "$app_id" android.permission.CAMERA >/dev/null 2>&1 || true

adbs shell setprop debug.relayium.backend "$android_origin" \
  || fail "could not point the device at $android_origin"
[ "$(adbs shell getprop debug.relayium.backend | tr -d '\r')" = "$android_origin" ] \
  || fail "the backend property did not take"
say "-- the device is pointed at $android_origin"

# ── the fixture ──────────────────────────────────────────────────────────────
#
# `am instrument -e name value` puts the value in the argv of a process: visible
# to `ps`, echoed by a traced shell, and written into the instrumentation log a
# failed run gets attached to. So the secrets go to app-private storage instead,
# on STDIN, under a FIXED quoted remote command. Nothing below interpolates a
# secret into a command line on either side.
#
# The message is base64 because `LiveFixture` trims each value as it parses, and
# the whitespace at both ends of that message is the thing under test.
message_b64="$(printf '  \xe4\xbd\xa0\xe5\xa5\xbd  relayium %s  \t ' "$run_tag" | base64 | tr -d '\n')"

# **Two rules, and they do not share a transport.**
#
# *The quoting.* `adb shell run-as X sh -c 'cat > f'` does NOT pass an argument
# vector: adb JOINS its arguments with spaces and the device's shell re-splits
# the result. The host's quotes are eaten by the host's shell, so the device sees
# `run-as X sh -c cat > f` and the REMOTE shell owns the redirection — the file
# is written by the shell user outside the app sandbox rather than by `run-as`
# inside it. Every remote command here is therefore ONE string whose quotes
# survive the rejoin.
#
# *The directory.* `pm clear` removes the app's data, and `filesDir` is not
# recreated until the app itself next starts — so straight after the run's one
# reset there is nowhere to write and the remote shell answers "cannot create
# files/live-fixture.properties: no such file or directory". The remote program
# therefore creates it, under the SAME `run-as` so it is owned by the app rather
# than by the shell user.
#
# Launching the app first to let it bootstrap its own directories would be the
# other way, and it is worse: the fixture would then be written into a process
# that is already running, racing the parse it exists to feed.
#
# *The direction.* `exec-out` reads back correctly but does NOT carry stdin to
# the remote command. An upload through it hangs the remote `cat` and leaves a
# zero-length file — observed, not theorised: a first-leg run spent 366s without
# the instrumentation ever starting, against a fixture of 0 lines. Uploads go
# through `adb shell -T` (no PTY, so nothing mangles the bytes); only read-backs
# use `exec-out`.
provision_fixture() {
  # $1 optional extra `key=value` line, for a leg that needs one.
  {
    printf 'origin=%s\n' "$android_origin"
    printf 'email=%s\n' "$account_email"
    printf 'password=%s\n' "$account_password"
    printf 'email2=%s\n' "$second_email"
    printf 'password2=%s\n' "$second_password"
    printf 'appleName=%s\n' "$apple_name"
    printf 'peerUrl=%s\n' "$peer_url"
    printf 'controlToken=%s\n' "$control_token"
    printf 'runTag=%s\n' "$run_tag"
    printf 'textB64=%s\n' "$message_b64"
    if [ -n "${1:-}" ]; then printf '%s\n' "$1"; fi
  } | adbs shell -T \
    "run-as $app_id sh -c 'mkdir -p files && cat > files/live-fixture.properties'"

  # Verified by SHAPE, never by content: a `cat` of this file would put the
  # password on this terminal, which is the whole thing the arrangement avoids.
  local lines
  lines="$(adbs exec-out "run-as $app_id sh -c 'wc -l < files/live-fixture.properties'" \
    | tr -d '\r ' || true)"
  case "$lines" in
    ''|*[!0-9]*) fail "the fixture could not be read back on the device" ;;
  esac
  [ "$lines" -ge 10 ] || fail "the fixture arrived truncated ($lines lines)"
}

# What the leg itself observed, from the app's OWN private storage.
#
# `InteropDriver.report` writes to `filesDir`, not to the instrumentation log, so
# this is a `run-as` read rather than a parse of stdout — and it is VALIDATED as
# JSON here rather than echoed, because a report is evidence for the record and
# not something to print at a terminal.
# ONE field from a leg's report. A file path goes to python, never the document:
# a report can be large, and passing its text as an argument is how a helper ends
# up failing with "Argument list too long" on a bigger run.
report_field() {
  python3 -c '
import json, sys
print(json.load(open(sys.argv[1])).get(sys.argv[2], ""))' "$out_dir/report-$1.json" "$2"
}

read_leg_report() {
  local leg="$1" dest="$out_dir/report-$1.json"
  adbs exec-out run-as "$app_id" cat files/host-inbox-live >"$dest" 2>/dev/null || true
  [ -s "$dest" ] || return 1
  # A `cat` of a missing file exits non-zero AND `adb` still exits 0, so the
  # shape is the only trustworthy signal: this must be an object that names the
  # leg it came from, or it is a leftover from the previous one.
  python3 - "$dest" "$leg" <<'PYEOF' || return 1
import json, sys
d = json.load(open(sys.argv[1]))
if not isinstance(d, dict):
    raise SystemExit("the leg report is not an object")
if "leg" not in d:
    raise SystemExit("the leg report does not name its leg")
PYEOF
  return 0
}

# ── the separate-UID reader ──────────────────────────────────────────────────
#
# The reader is a DIFFERENT app, so the instrumentation cannot read its report:
# only `run-as com.relayium.acceptance.reader` can. That is why the product's
# open/share is driven by the test and the report is judged HERE.
#
# The contract this asserts against, per root's fixture:
#
#   top level : ok, error, count, process, delivery, nonce, recheck
#   per file  : name, read1, read2, writeDenied, writeErrorIsSecurity
#
# A missing key is a FAILURE, never a default. A validator that treated an
# absent `ok` as false would pass a fixture that had stopped reporting.
reader_run_as() {
  # `$1` is the remote PROGRAM, unquoted here and quoted into the single remote
  # argv below - the same rejoin rule the fixture write obeys.
  adbs exec-out "run-as $reader_pkg sh -c '$1'" 2>/dev/null
}

# Deleted BEFORE the delivery that should write it. A stale report from an
# earlier delivery is indistinguishable from a fresh one, and it is the artifact
# the revoke gate depends on.
reader_clear_reports() {
  reader_run_as 'rm -f files/received.json files/recheck.json' >/dev/null || true
  # `grep -c` prints a COUNT, and the count for "nothing left" is `0` — which is
  # not an empty string. Testing for emptiness here failed every clean clear, and
  # would have reported "the reader still holds a report: 0".
  local left
  left="$(reader_run_as 'ls files 2>/dev/null | grep -c json' | tr -d '\r ')"
  case "$left" in
    0|'') : ;;
    *[!0-9]*) fail "could not read the reader's report directory back" ;;
    *) fail "the reader still holds $left report(s) after the clear" ;;
  esac
}

reader_pull() {
  local which="$1" dest="$2"
  reader_run_as "cat files/$which" >"$dest" || true
  [ -s "$dest" ] || return 1
  return 0
}

# The FIRST delivery: the grant works, it can be reopened, and a write is
# refused by the provider rather than by the file being gone.
assert_reader_initial() {
  local doc="$1"
  python3 - "$doc" "$out_dir/reader-identity.txt" <<PYEOF || fail "the reader's first report does not support this run"
import json, sys
d = json.load(open(sys.argv[1]))
# ok FIRST. The fixture publishes ok:false from its own catch, and a report
# that failed before it had filled anything in has no count either - checking
# key presence first would report "the contract changed" for what is actually
# "the fixture told us it failed, and why".
if "ok" not in d:
    raise SystemExit("the reader report has no 'ok'; the fixture contract changed")
if d["ok"] is not True:
    raise SystemExit("the reader reported not-ok: %s" % d.get("error", "<no error given>"))
for k in ("count", "process", "delivery", "files"):
    if k not in d:
        raise SystemExit("the reader report has no %r; the fixture contract changed" % k)
if d.get("recheck"):
    raise SystemExit("the first report must not be a recheck")
if int(d["count"]) < 1:
    raise SystemExit("the reader was granted nothing; a zero-file report proves nothing")
if len(d["files"]) != int(d["count"]):
    raise SystemExit("the reader's count and file list disagree")
for f in d["files"]:
    for k in ("name", "read1", "read2", "writeDenied"):
        if k not in f:
            raise SystemExit("a reader file entry has no %r" % k)
    # All three together, deliberately. writeDenied ALONE is also what a
    # revoked or missing grant produces, so asserting it by itself would
    # confirm write-protection on a URI that grants nothing at all.
    if not (f["read1"] and f["read2"]):
        raise SystemExit("the external reader could not read (or reopen) a granted file")
    if not f["writeDenied"]:
        raise SystemExit("the external reader was able to open a granted file for WRITING")
    if "writeErrorIsSecurity" in f and not f["writeErrorIsSecurity"]:
        raise SystemExit("the write refusal was not a security refusal")
# Identity only. Names are plaintext-derived and stay out of stdout.
open(sys.argv[2], "w").write("%s %s %d\n" % (d["process"], d["delivery"], int(d["count"])))
print("reader: %d granted file(s), each read twice, each write refused" % int(d["count"]))
PYEOF
}

# ── the run ──────────────────────────────────────────────────────────────────
failures=0
passed_legs=0
# Facts one leg establishes and a later one REQUIRES. They are carried through
# the protected fixture rather than re-derived: `historySurvivesARestart` must
# name the exact entry that has to come back, and an entry it looked up for
# itself after the restart would be asserting that the store agrees with itself.
deleted_entry_id=""
surviving_entry_id=""
surviving_key=""
surviving_sha=""

leg_index=0
for leg in $legs; do
  leg_index=$((leg_index + 1))
  if [ -n "$leg_limit" ] && [ "$leg_index" -gt "$leg_limit" ]; then
    say ""
    say "== stopping after $leg_limit leg(s), as asked =="
    break
  fi
  say ""
  say "== $leg =="

  # A restart is the POINT of this leg, not an accident of it: the runtime, every
  # store and the whole controller generation must be rebuilt from disk.
  extra=""
  if [ "$leg" = "opensAndSharesToTheExternalReader" ]; then
    # Before the delivery, not after: a stale report is indistinguishable from a
    # fresh one, and this is the artifact the revoke gate rests on.
    reader_clear_reports
  fi
  if [ "$leg" = "historySurvivesARestart" ]; then
    # The restart IS the leg. Every store, the runtime and the whole controller
    # generation must be rebuilt from disk, or nothing here is about persistence.
    adbs shell am force-stop "$app_id" >/dev/null 2>&1 || true
    for required in "$deleted_entry_id" "$surviving_entry_id" "$surviving_key" \
                    "$surviving_sha"; do
      [ -n "$required" ] || fail \
        "the restart leg needs the earlier legs' entry ids and digest; one is missing"
    done
    extra="deletedEntryId=$deleted_entry_id
survivingEntryId=$surviving_entry_id
survivingKey=$surviving_key
survivingSha=$surviving_sha"
  fi

  # Drop any earlier leg's report BEFORE this one runs. `read_leg_report` can
  # only check that a document names A leg, not THIS leg — the labels are short
  # slugs, not method names — so a leg that failed before reporting would
  # otherwise be credited with its predecessor's evidence.
  adbs exec-out "run-as $app_id sh -c 'rm -f files/host-inbox-live'" >/dev/null 2>&1 || true

  provision_fixture "$extra"
  log="$out_dir/instrument-$leg.log"

  set +e
  adbs shell am instrument -w -r \
    -e class "$test_class#$leg" \
    "$test_pkg/$runner" >"$log" 2>&1
  status=$?
  set -e

  # Kept and reported alongside the semantic verdict. `am instrument` exits 0
  # when the app crashed and when nothing ran, so the exit alone proves nothing —
  # and discarding it would lose the one signal that says adb itself failed.
  say "-- am instrument original exit: $status"

  if [ "$status" -ne 0 ] || ! "$here/lib/instrumentation-result.sh" "$log" 1; then
    say "-- FAILED: $leg (am instrument original exit $status)"
    # **The stack does NOT go to this terminal.**
    #
    # A Compose assertion failure prints the node tree, and this suite types an
    # account password and a message body into real text fields. Those values
    # can appear in an `EditableText` node or in an assertion's "actual" half, so
    # the raw log is kept PRIVATE and only the exception's shape is surfaced.
    # Root reads the full log from the run directory.
    say "-- the full instrumentation log is private: $log"
    awk '/INSTRUMENTATION_STATUS: stack=/ { getline; if (shown < 3) { print "   " $0; shown++ } }' \
      "$log" 2>/dev/null | sed 's/[[:print:]]\{160,\}/<long line withheld>/' >&2 || true
    failures=$((failures + 1))
    # A partial report is worth more than a clean slate: whatever the leg
    # observed is captured BEFORE anything is force-stopped.
    read_leg_report "$leg" || say "-- the failed leg left no readable evidence"
    break
  fi

  read_leg_report "$leg" || fail "$leg passed but produced no readable evidence"
  case "$leg" in
    receivesTheAndroidParityBatchWhileForeground)
      surviving_entry_id="$(report_field "$leg" survivingEntryId)"
      surviving_key="$(report_field "$leg" survivingKey)"
      surviving_sha="$(report_field "$leg" survivingSha)"
      [ -n "$surviving_entry_id" ] && [ -n "$surviving_key" ] && [ -n "$surviving_sha" ] \
        || fail "the batch leg did not name what the restart leg must require back"
      ;;
    deletionRemovesTheEntryAndItsBody)
      deleted_entry_id="$(report_field "$leg" removed)"
      [ -n "$deleted_entry_id" ] || fail "the delete leg named no entry for the restart leg"
      ;;
  esac
  case "$leg" in
    opensAndSharesToTheExternalReader)
      # Polled, not read once. The fixture now DELETES the report as it accepts
      # the intent and republishes only when its own generation is still the
      # latest, so the file is legitimately absent for the whole window between
      # the hand-off and the publish. Reading once would race that window and
      # report "no report" for a reader that was simply still working.
      initial_waited=0
      while [ "$initial_waited" -lt 60 ]; do
        reader_pull received.json "$out_dir/reader-received.json" && break
        sleep 0.5
        initial_waited=$((initial_waited + 1))
      done
      [ -s "$out_dir/reader-received.json" ] \
        || fail "the external reader wrote no report within 30s"
      assert_reader_initial "$out_dir/reader-received.json"
      ;;
    aNewIdentityCancelsTheOldAccountsWork)
      # The revocation proof is NOT re-run here, deliberately.
      #
      # It has to observe one grant working and then stopping without the
      # Activity being torn down in between, because `onCleared` calls
      # `SharedFileGrants.revokeAll()` and every leg's teardown runs it. A
      # baseline from an earlier leg plus a re-check driven from here would show
      # the grant gone whatever the account did — the teardown would have done
      # it — and this script would report a revocation nobody observed.
      #
      # So the leg owns the whole sequence inside one invocation, and what is
      # left here is to VALIDATE the typed receipts it recorded.
      python3 - "$out_dir/report-$leg.json" <<'PYEOF' \
        || fail "the identity-switch leg did not prove external revocation"
import json, sys
d = json.load(open(sys.argv[1]))
for key in ("readerProcess", "readerDelivery", "grantedCount",
            "sameProcess", "externallyRevoked", "oldGrantsRevoked"):
    if key not in d:
        raise SystemExit("the leg did not record %r" % key)
if int(d["grantedCount"]) < 1:
    raise SystemExit("the reader was granted nothing, so nothing was revoked")
for key in ("sameProcess", "externallyRevoked", "oldGrantsRevoked"):
    if d[key] is not True:
        raise SystemExit("%s was not established" % key)
print("revocation: %d retained URI(s), same reader process, none readable after "
      "the identity changed" % int(d["grantedCount"]))
PYEOF
      ;;
  esac
  passed_legs=$((passed_legs + 1))
  say "-- PASSED: $leg"
done

# ── the far side, independently ──────────────────────────────────────────────
#
# Read from the endpoint AFTER the run rather than trusting what the device said
# about it. The peer walks its own receive root off disk, so this is a second
# observer rather than a second copy of the first one's answer.
# Only for a COMPLETE run. The oracle asserts that files crossed to the Mac, and
# a deliberately truncated run has not sent any yet — leg 1 signs in and enrols
# and nothing more. Running it anyway would fail a first-leg pass for the one
# reason the operator explicitly asked for.
if [ "$failures" -eq 0 ] && [ -z "$leg_limit" ]; then
  control "$apple_port" GET /observed >"$out_dir/apple-observed.json" \
    || fail "the endpoint would not report what it holds"
  python3 - "$out_dir/apple-observed.json" "$multiframe_bytes" <<'PY' \
    || fail "the endpoint's own evidence does not support this run"
import json, sys
doc = json.load(open(sys.argv[1]))
want = int(sys.argv[2])
files = doc.get("files", [])
if not files:
    raise SystemExit("the Mac holds no received files at all")
if not any(f.get("size", 0) >= want for f in files):
    raise SystemExit("no file past one 192 KiB chunk reached the Mac")
if not any(f.get("size", 0) == 0 for f in files):
    raise SystemExit("the zero-byte file never reached the Mac")
# Counts and sizes only. Received file NAMES are plaintext-derived and local.
print("endpoint evidence: %d files, largest %d bytes"
      % (len(files), max(f.get("size", 0) for f in files)))
PY
fi

say ""
if [ "$failures" -ne 0 ]; then
  say "android-host-inbox-acceptance: FAILED after $passed_legs passing leg(s)"
  say "evidence: $out_dir"
  exit 1
fi

if [ -n "$leg_limit" ]; then
  say "android-host-inbox-acceptance: PASSED $passed_legs leg(s) of a DELIBERATELY"
  say "truncated run (RELAYIUM_HOST_INBOX_LEGS=$leg_limit). This is not the suite."
  say "evidence: $out_dir"
  completed=1
  exit 0
fi

say "android-host-inbox-acceptance: PASSED all $passed_legs legs"
say "evidence: $out_dir"
say ""
say "This run proves the Inbox end to end between an Android runtime (emulator"
say "or device) and a macOS endpoint. It is NOT physical-hardware evidence for"
say "either side. It does NOT prove receive-side cancellation, which needs a"
say "peer that can hold a transfer mid-flight; see"
say "docs/android-host-inbox-acceptance.md for the sequence that covers it."
completed=1
