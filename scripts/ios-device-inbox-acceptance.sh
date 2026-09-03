#!/bin/bash
# Two PHYSICAL iOS devices completing ONE real Device Inbox delivery — a
# run-unique message and a deterministic file — through the installed product's
# own account session, asserted at both ends and proved by digest.
#
# ── what this drives ─────────────────────────────────────────────────────────
#
# `RelayiumUITests/DeviceInboxAcceptanceUITests` holds the two roles this
# launcher starts, exactly one per device:
#
#   * the RECEIVER adopts its manually signed-in account, turns the shipped
#     receiving consent to automatic through the product's own control, opens
#     the sending device's conversation, and requires this run's message and
#     the exact staged brief to COMMIT into a timeline row that did not exist
#     when the run began;
#   * the SENDER adopts its own manually signed-in session, opens the receiving
#     device's page, sends one run-unique message, then picks the Debug-staged
#     brief through the real system Files picker and sends it — requiring both
#     outgoing rows to reach "Saved on the other device", a state only the
#     peer's commit, observed through the sender's tracking poll, can produce.
#
# Each role publishes bounded `RELAYIUM-DEVICE-INBOX` lines into its own
# xcodebuild log. This launcher reads them back through
# `scripts/lib/device_pair_channel.py`, which refuses anything outside the
# grammar both ends define — a stale run's tag, the other role's line, the
# pair harness's marker, or a value outside the event's own shape.
#
# ── the launch is the shipped one ────────────────────────────────────────────
#
# Neither role passes `--relayium-ui-testing`, `--relayium-transfer-origin`,
# `--relayium-ui-testing-fresh-received-folder`, or any credential, and neither
# does this launcher. The keychain, the session, the enrolment, the device key,
# the receive loop, the receive folder and the send pipeline are the installed
# product's own. The one Debug-only argument the SENDER's role adds — inside
# the suite, not here — stages the 1,536-byte brief into the sending app's own
# Documents and does nothing else.
#
# ── what it proves ───────────────────────────────────────────────────────────
#
#   * ONE deterministic file — 1,536 bytes of 0x52, chosen through the real
#     system document browser — travels the real account route into the
#     receiving device's `Documents/Received`, and its BYTES are then read out
#     of that device's own app container while the receiving app is still
#     foreground on its committed state, and hashed here against a digest this
#     script holds independently of both devices.
#   * ONE run-unique message, exact character for character, asserted inside a
#     timeline row minted after this run began — on both surfaces.
#   * The exact file NAME rendered on both surfaces, and a terminal state on
#     both: the receiver's committed row, the sender's "Saved on the other
#     device".
#   * That the receiving app KEEPS the committed state foreground for its fixed
#     holding window and only then finishes: DONE after HOLDING, with nothing
#     signalling into the window and nothing written to either device.
#
# ── what it does NOT prove ───────────────────────────────────────────────────
#
#   * NOT the reverse direction. One run is one delivery, sender to receiver;
#     exchanging the devices' roles is a second, separate run an operator
#     starts deliberately. Nothing here re-runs itself the other way round.
#   * NOT background delivery. Receiving is foreground-only on this build and
#     says so; the run keeps the receiving app on screen for that reason.
#   * NOT delivery to an offline device that comes back, a Web/macOS/CLI
#     sender, or the file surviving the receipt being dismissed — the receiver
#     holds and finishes, and nothing here drives a post-exit read.
#   * NOT anything, if the offline inbox suites ran instead: they seed history
#     through stores and say so in their own headers. Only the two roles named
#     below move bytes, and `--self-test` pins that they are the only tests
#     this launcher can start.
#
# ── how the run is sequenced, and why the sender sits idle at first ──────────
#
# ONE device is started at a time. The receiver is started alone, and the
# sender only after the receiver has PUBLISHED that the product's own status
# line reports it ready to receive. That is a handshake, not a pause: starting
# a role starts an `xcodebuild` UI-test session, and that session has to enable
# Automation Mode on its device first. Two started in the same breath contend
# for it, one device times out enabling automation, and the other then fails
# for the only reason left — the peer never launched — with the log naming the
# wrong device and no product claim tested at all. Sequencing also keeps the
# receiving app foreground from before the delivery until after the digest.
#
# ── the digest window ────────────────────────────────────────────────────────
#
# After its assertions pass, the receiver publishes HOLDING and stays
# foreground on the committed state for a fixed, strictly bounded window
# (90 seconds; the suite clamps to 30–300). Inside that window this launcher
# takes its one read: `devicectl device copy from` on the receiving app's own
# container, `Documents/Received/Relayium product brief.txt`, into this run's
# evidence directory, hashed and required equal to the staged digest. Nothing
# shortens the window and nothing signals into it — this launcher writes
# NOTHING to either device, ever. The window elapses on its own, the receiver
# asserts it stayed foreground, publishes DONE, and exits naturally.
#
# ── preconditions this script cannot create for you ──────────────────────────
#
#   * BOTH devices signed in BY HAND, once, to the SAME Relayium account, with
#     any verify/frozen state resolved on the Account screen. The Device Inbox
#     is an account feature end to end. Because no `--relayium-ui-testing` is
#     passed, the app uses the product's own keychain and the session persists
#     across runs — which is why this harness holds no credential, reads no
#     credential environment variable, and has nothing to redact from a log. A
#     device without a session SKIPS with the manual step quoted.
#   * The receiving device's `Received` folder must not already hold a file
#     named `Relayium product brief.txt`. The product REFUSES a taken flat
#     name on commit rather than overwrite or rename, so a copy left by an
#     earlier run makes THIS run fail honestly. Deleting it (Files app →
#     Relayium → Received) between runs is an operator step, exactly like
#     Automation Mode — never something this harness does to keep itself green.
#   * Both devices unlocked, awake, online and trusted by this Mac, with
#     Automation Mode available. This script never changes a network setting,
#     never reboots, erases, restores or removes anything on a device, and
#     never touches cellular.
#
# ── what a FAILED run collects, and what it will never do to collect it ──────
#
# The last 60 lines of each role's own log, the published-event choreography
# read out of those same logs, on a failed byte check ONLY a read-only listing
# of the receiving app's own Documents, and the per-role `.xcresult` bundles
# and full logs, KEPT under the evidence directory the run names on its first
# line and names again when it fails. It runs nothing that could raise a
# system authentication dialog, and `--self-test` proves that offline.
#
# ── usage ────────────────────────────────────────────────────────────────────
#
#   scripts/ios-device-inbox-acceptance.sh --sender <DEVICE> --receiver <DEVICE> \
#       [--sender-peer-id ID] [--receiver-peer-id ID] \
#       [--output DIR] [--peer-budget SECONDS] [--delivery-budget SECONDS] \
#       [--skip-build] [--xcodebuild-arg ARG]...
#
#   scripts/ios-device-inbox-acceptance.sh --self-test    # touches no device
#
# Both devices are REQUIRED and are never guessed: this script drives real
# hardware and picking a device on the operator's behalf is not a decision it
# may make. `--sender` and `--receiver` accept EITHER identifier Apple's own
# tools print — the CoreDevice identifier from `xcrun devicectl list devices`
# or the hardware UDID — resolved against one snapshot, refusing zero or two
# matches; see `scripts/lib/ios-physical-device.sh`.
#
# `--sender-peer-id` names the conversation row the SENDER must select — the
# RECEIVING device's id in the account's device directory. `--receiver-peer-id`
# names the conversation the RECEIVER must open — the SENDING device's id.
# Each is forwarded to its own role as `RELAYIUM_DEVICE_INBOX_PEER_ID` and
# matched as the COMPLETE identifier, never a suffix. Omitted, each role
# proceeds only when its list offers exactly one row; two rows are a refusal
# naming both, not a guess. Each runner also publishes the id it actually
# used, and this launcher compares it with the one given — so swapped ids fail
# with that diagnosis rather than delivering somewhere nobody named.

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
project="$repo_root/apps/ios/Relayium.xcodeproj"
channel="$repo_root/scripts/lib/device_pair_channel.py"
device_lib="$repo_root/scripts/lib/ios-physical-device.sh"

# shellcheck source-path=SCRIPTDIR
# shellcheck source=lib/local-acceptance.sh
source "$repo_root/scripts/lib/local-acceptance.sh"
# shellcheck source-path=SCRIPTDIR
# shellcheck source=lib/ios-physical-device.sh
source "$device_lib"

# ── the vocabulary this harness reads ────────────────────────────────────────
#
# Its own marker, because the pair harness publishes through the same grammar
# and both vocabularies contain READY. The channel holds every event to the
# suite's own value shapes, so a malformed line is refused rather than read.
marker="RELAYIUM-DEVICE-INBOX"
suite="RelayiumUITests/DeviceInboxAcceptanceUITests"
receiver_test="testPhysicalReceiverCommitsOneRunUniqueMessageAndTheStagedBrief"
sender_test="testPhysicalSenderDeliversOneRunUniqueMessageAndTheStagedBrief"

# Every event each role must have published before this run may pass. Each is
# emitted by the suite only after the assertion behind it held on that device,
# so requiring the full set is requiring the choreography, not decoration.
# `--self-test` pins both lists, and the seam tests pin them against the
# suite's own enum.
sender_events="READY TARGET MESSAGE NAME FILE DONE"
receiver_events="READY PEER RECEIVING MESSAGE NAME FILE HOLDING DONE"

# ── what the receiving device must end up holding ────────────────────────────
#
# `UITestMode.stagePendingFixture` writes exactly 1,536 bytes of 0x52 under
# `UITestMode.pendingFixtureName`, and every iOS receive path lands in
# `ReceiveDestination.directory()` — `Documents/Received` inside the app's own
# container. The digest is a constant here, never a value read back off the
# sending device, which is what makes the comparison a comparison and not an
# echo; `--self-test` re-derives it from the fixture's own rule.
#
# The bundle id is the app's, not this harness's. It moved onto the macOS
# identifier when iOS joined the one universal-purchase App Store record, and
# `DeviceInboxAcceptanceSeamTests` pins this literal against the product's own
# so the container this reads and the container the app writes cannot drift.
bundle_id="com.relayium.mac"
fixture_name="Relayium product brief.txt"
fixture_container_path="Documents/Received/$fixture_name"
fixture_bytes=1536
fixture_byte=0x52
fixture_sha256="1d71499ab7454d9955704333e6fddbded53e45217087bfdbaf529436765cfcfc"

expected_digest() {
  python3 -c 'import hashlib, sys
count = int(sys.argv[1])
fill = int(sys.argv[2], 16)
sys.stdout.write(hashlib.sha256(bytes([fill]) * count).hexdigest())' \
    "$fixture_bytes" "$fixture_byte"
}

# ── arguments ────────────────────────────────────────────────────────────────

sender_device=""
receiver_device=""
sender_peer_id=""
receiver_peer_id=""
output_root=""
peer_budget=300
delivery_budget=300
skip_build=0
self_test=0
declare -a xcodebuild_extra=()

usage() {
  sed -n '2,/^set -euo/p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//; $d' >&2
  exit 2
}

while [ $# -gt 0 ]; do
  case "$1" in
    --sender) sender_device="${2:-}"; shift 2 ;;
    --receiver) receiver_device="${2:-}"; shift 2 ;;
    --sender-peer-id) sender_peer_id="${2:-}"; shift 2 ;;
    --receiver-peer-id) receiver_peer_id="${2:-}"; shift 2 ;;
    --output) output_root="${2:-}"; shift 2 ;;
    --peer-budget) peer_budget="${2:-}"; shift 2 ;;
    --delivery-budget) delivery_budget="${2:-}"; shift 2 ;;
    --skip-build) skip_build=1; shift ;;
    --xcodebuild-arg) xcodebuild_extra+=("${2:-}"); shift 2 ;;
    --self-test) self_test=1; shift ;;
    -h|--help) usage ;;
    *) say "unknown argument: $1"; usage ;;
  esac
done

for budget_value in "$peer_budget" "$delivery_budget"; do
  case "$budget_value" in
    ''|*[!0-9]*) say "budgets are whole seconds"; usage ;;
  esac
  [ "$budget_value" -ge 60 ] && [ "$budget_value" -le 1800 ] \
    || { say "budgets must be between 60 and 1800 seconds"; usage; }
done

# The channel's own bounded token set, checked before anything is spent: a
# value outside it could never be echoed back by the runner, so the run would
# fail late, at the far end of a build and a device queue, instead of here.
for peer_id in "$sender_peer_id" "$receiver_peer_id"; do
  [ -n "$peer_id" ] || continue
  case "$peer_id" in
    *[!0-9A-Za-z._-]*)
      say "not a device-directory id (letters, digits, '.', '_', '-'): $peer_id"
      exit 2 ;;
  esac
  [ "${#peer_id}" -le 64 ] \
    || { say "a device-directory id is at most 64 characters: $peer_id"; exit 2; }
done

# ── proving this harness WITHOUT touching a device ───────────────────────────
#
# Everything below runs with nothing plugged in. It is the gate that has to
# catch a defect a physical run would otherwise spend two devices, a build and
# many minutes discovering.

self_test_fixture() {
  cat >"$1" <<'JSON'
{"result":{"devices":[
  {"identifier":"aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
   "deviceProperties":{"name":"Inbox fixture phone"},
   "hardwareProperties":{"udid":"00008130-000FACADE0F00D01","productType":"iPhone15,2",
                         "platform":"iOS"}},
  {"identifier":"12121212-3434-5656-7878-909090909090",
   "deviceProperties":{"name":"Inbox fixture tablet"},
   "hardwareProperties":{"udid":"00008103-000CAFEBABE00A02","productType":"iPad7,11",
                         "platform":"iOS"}}
]}}
JSON
}

self_test_cases=0
self_test_failures=0

self_test_expect() {
  local what="$1" want="$2" got="$3"
  self_test_cases=$((self_test_cases + 1))
  if [ "$want" != "$got" ]; then
    self_test_failures=$((self_test_failures + 1))
    say "   FAIL $what: expected [$want], got [$got]"
  fi
}

# Whether a refusal actually SAID why, so a case cannot be satisfied by any
# non-zero exit.
self_test_mentions() {
  case "$1" in *"$2"*) printf 'said' ;; *) printf 'silent' ;; esac
}

# Whether a string is inside the channel's bounded token set, with its length —
# executed as a function so the self-test drives the same classification a
# reader would otherwise only read.
self_test_token_shape() {
  case "$1" in
    ''|*[!0-9A-Za-z._-]*) printf 'refused' ;;
    *) printf 'emittable %s' "${#1}" ;;
  esac
}

# Resolve a selector against a fixture and report `status|field`, so one case
# asserts the refusal AND the value.
self_test_resolve() {
  local snapshot="$1" selector="$2" field="$3" facts="" status=0
  facts="$(ios_device_facts "$snapshot" "$selector")" || status=$?
  if [ "$status" -ne 0 ]; then printf '%s|' "$status"; return 0; fi
  printf '0|%s' "$(printf '%s' "$facts" | cut -f"$field")"
}

# The exact `TEST_RUNNER_*` names that reach a device, read out of
# `start_role`'s own body rather than off the whole file — a scan over the
# file would be satisfied by its own expected-list text.
exported_runner_variables() {
  ios_joined_source "${BASH_SOURCE[0]}" \
    | awk '/^start_role\(\) \{$/,/^\}$/' \
    | grep -oE 'TEST_RUNNER_RELAYIUM_DEVICE_INBOX_[A-Z_]+' \
    | sort -u | tr '\n' ' '
}

# Every `-only-testing:` selector this run can name, from the same body.
only_testing_selectors() {
  ios_joined_source "${BASH_SOURCE[0]}" \
    | awk '/^start_role\(\) \{$/,/^\}$/' \
    | grep -oE '\-only-testing:"[^"]*"' | sort -u | tr '\n' ' '
}

run_self_test() {
  local scratch devices gate_log live dead status out value

  scratch="$(mktemp -d "${TMPDIR:-/tmp}/relayium-inbox-selftest.XXXXXX")" \
    || { say "the self-test cannot create a temporary directory"; exit 1; }
  devices="$scratch/devices.json"
  gate_log="$scratch/role.log"
  self_test_fixture "$devices"

  say "== self-test: the grammar this harness reads from outside itself =="
  python3 "$channel" self-test >&2 \
    || { say "   FAIL the channel self-test did not pass"; self_test_failures=1; }

  say "== self-test: resolving ONE selector to ONE device =="
  self_test_expect "a CoreDevice identifier resolves to the hardware UDID" \
    "0|00008130-000FACADE0F00D01" \
    "$(self_test_resolve "$devices" "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee" 5)"
  self_test_expect "a hardware UDID resolves to itself" \
    "0|00008103-000CAFEBABE00A02" \
    "$(self_test_resolve "$devices" "00008103-000CAFEBABE00A02" 5)"
  self_test_expect "both forms of one device resolve to the SAME hardware UDID" \
    "$(self_test_resolve "$devices" "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee" 5)" \
    "$(self_test_resolve "$devices" "00008130-000FACADE0F00D01" 5)"
  self_test_expect "an unknown selector matches nothing" \
    "3|" "$(self_test_resolve "$devices" "not-a-device" 5)"
  self_test_expect "a PREFIX of a real identifier matches nothing" \
    "3|" "$(self_test_resolve "$devices" "aaaaaaaa" 5)"

  say "== self-test: a device is never guessed, through this script's own front door =="
  status=0
  out="$(bash "${BASH_SOURCE[0]}" --receiver 00008103-000CAFEBABE00A02 2>&1)" || status=$?
  self_test_expect "a missing --sender refuses instead of picking one" \
    "exit 2 said" "exit $status $(self_test_mentions "$out" "--sender is required")"
  status=0
  out="$(bash "${BASH_SOURCE[0]}" --sender 00008130-000FACADE0F00D01 2>&1)" || status=$?
  self_test_expect "a missing --receiver refuses instead of picking one" \
    "exit 2 said" "exit $status $(self_test_mentions "$out" "--receiver is required")"
  status=0
  out="$(bash "${BASH_SOURCE[0]}" --sender same-thing --receiver same-thing 2>&1)" || status=$?
  self_test_expect "one selector for both ends is refused before any device is read" \
    "exit 2 said" "exit $status $(self_test_mentions "$out" "name the same device")"
  status=0
  out="$(bash "${BASH_SOURCE[0]}" --sender a --receiver b --sender-peer-id "has space" 2>&1)" \
    || status=$?
  self_test_expect "a peer id outside the channel's token set is refused up front" \
    "exit 2 said" "exit $status $(self_test_mentions "$out" "device-directory id")"
  status=0
  out="$(bash "${BASH_SOURCE[0]}" --sender a --receiver b \
         --sender-peer-id twin --receiver-peer-id twin 2>&1)" || status=$?
  self_test_expect "one directory id for both ends is refused" \
    "exit 2 said" "exit $status $(self_test_mentions "$out" "the same device-directory id")"

  say "== self-test: the start barrier, with no device anywhere =="
  ( sleep 60 ) & live=$!
  printf '%s ffffffff receiver RECEIVING auto\n' "$marker" >"$gate_log"
  self_test_expect "the receiver's own RECEIVING opens the gate" \
    "0|auto" \
    "$(value="$(ios_await_event "$channel" "$gate_log" ffffffff receiver RECEIVING \
        "$live" 6 "$marker" 2>/dev/null)" \
       && printf '0|%s' "$value" || printf '%s|' "$?")"
  # An earlier event of the same role must not: READY is not "receiving".
  printf '%s ffffffff receiver READY 1\n' "$marker" >"$gate_log"
  self_test_expect "the receiver's READY does not open the RECEIVING gate" \
    "2|" \
    "$(value="$(ios_await_event "$channel" "$gate_log" ffffffff receiver RECEIVING \
        "$live" 4 "$marker" 2>/dev/null)" \
       && printf '0|%s' "$value" || printf '%s|' "$?")"
  # The pair harness publishes through the same grammar; only the marker tells
  # the two apart, and both can be started from one queue.
  printf 'RELAYIUM-DEVICE-PAIR ffffffff receiver RECEIVING auto\n' >"$gate_log"
  self_test_expect "the other harness's line does not open this gate" \
    "2|" \
    "$(value="$(ios_await_event "$channel" "$gate_log" ffffffff receiver RECEIVING \
        "$live" 4 "$marker" 2>/dev/null)" \
       && printf '0|%s' "$value" || printf '%s|' "$?")"
  printf '%s 0badcafe receiver RECEIVING auto\n' "$marker" >"$gate_log"
  self_test_expect "a previous run's line does not open this gate" \
    "2|" \
    "$(value="$(ios_await_event "$channel" "$gate_log" ffffffff receiver RECEIVING \
        "$live" 4 "$marker" 2>/dev/null)" \
       && printf '0|%s' "$value" || printf '%s|' "$?")"
  kill "$live" 2>/dev/null || true
  wait "$live" 2>/dev/null || true
  # A publisher that exited will never publish; the gate must say so in
  # seconds, not wait out a budget that is minutes long. The 120 bound is the
  # trade the pair harness records: a broken gate makes this case consume the
  # whole budget, so a bigger one turns a caught defect into a hung self-test.
  ( exit 0 ) & dead=$!
  wait "$dead" 2>/dev/null || true
  : >"$gate_log"
  self_test_expect "a publisher that exited is not waited out" \
    "1|" \
    "$(value="$(ios_await_event "$channel" "$gate_log" ffffffff receiver RECEIVING \
        "$dead" 120 "$marker" 2>/dev/null)" \
       && printf '0|%s' "$value" || printf '%s|' "$?")"

  say "== self-test: the digest anchor, from the fixture's own rule =="
  self_test_expect "the pinned digest is the digest of the fixture's rule" \
    "$fixture_sha256" "$(expected_digest)"

  say "== self-test: the run-unique message fits the channel both ends enforce =="
  self_test_expect "the composed message is inside the bounded token set" \
    "emittable 23" "$(self_test_token_shape "relayium-inbox-abcd1234")"
  self_test_expect "and the classifier can still refuse, so that reading means something" \
    "refused" "$(self_test_token_shape "has space")"

  say "== self-test: exactly these facts reach a device =="
  # An EXACT list rather than a presence check: an account, an address or a
  # token would be a NEW name here, and "the expected ones are present" cannot
  # see an addition.
  self_test_expect "exactly these facts reach a device, and none is a credential" \
    "TEST_RUNNER_RELAYIUM_DEVICE_INBOX_DELIVERY_BUDGET_SECONDS TEST_RUNNER_RELAYIUM_DEVICE_INBOX_MESSAGE TEST_RUNNER_RELAYIUM_DEVICE_INBOX_PEER_BUDGET_SECONDS TEST_RUNNER_RELAYIUM_DEVICE_INBOX_PEER_ID TEST_RUNNER_RELAYIUM_DEVICE_INBOX_ROLE TEST_RUNNER_RELAYIUM_DEVICE_INBOX_TAG " \
    "$(exported_runner_variables)"

  say "== self-test: only the physical acceptance suite can be started =="
  self_test_expect "exactly one test selector exists, and it is built from \$suite" \
    "-only-testing:\"\$suite/\$test_name\" " "$(only_testing_selectors)"
  self_test_expect "and \$suite is the physical acceptance suite" \
    "RelayiumUITests/DeviceInboxAcceptanceUITests" "$suite"
  self_test_expect "whose two roles are the two this launcher starts" \
    "testPhysicalReceiverCommitsOneRunUniqueMessageAndTheStagedBrief \
testPhysicalSenderDeliversOneRunUniqueMessageAndTheStagedBrief" \
    "$receiver_test $sender_test"

  say "== self-test: the required choreography is pinned =="
  self_test_expect "the sender's required events" \
    "READY TARGET MESSAGE NAME FILE DONE" "$sender_events"
  self_test_expect "the receiver's required events" \
    "READY PEER RECEIVING MESSAGE NAME FILE HOLDING DONE" "$receiver_events"

  say "== self-test: this file cannot prompt, destroy, or reach past its remit =="
  self_test_expect "no credential-seeking or destructive command in this file" \
    "" "$(ios_forbidden_command_hits "${BASH_SOURCE[0]}")"
  self_test_expect "none in the device library either" \
    "" "$(ios_forbidden_command_hits "$device_lib")"
  self_test_expect "every xcodebuild launch is detached from the terminal" \
    "2 launches, 0 bare" "$(ios_xcodebuild_launch_census "${BASH_SOURCE[0]}")"
  self_test_expect "the device library starts no xcodebuild of its own" \
    "0 launches, 0 bare" "$(ios_xcodebuild_launch_census "$device_lib")"
  # The one recursive delete this file has, pinned by target.
  # shellcheck disable=SC2016  # the single quotes are the point: this is the
  # literal text the scan must produce, not an expression to expand.
  self_test_expect "the only recursive delete targets this run's own scratch" \
    'rm -rf "$scratch";' "$(ios_recursive_delete_sites "${BASH_SOURCE[0]}")"
  # Every `devicectl` shape this file uses, pinned as a set. The one shape that
  # can WRITE — the pair harness's release — is deliberately NOT here: this
  # launcher writes nothing to any device, and a new shape appearing in this
  # set is a deliberate, reviewed edit rather than a line nobody noticed.
  self_test_expect "the launcher uses only the device shapes it documents" \
    "device copy from;list devices;" \
    "$(ios_devicectl_shapes "${BASH_SOURCE[0]}")"
  self_test_expect "the library's device shapes are unchanged underneath it" \
    "device copy from;device copy to;device info files;list devices;" \
    "$(ios_devicectl_shapes "$device_lib")"

  rm -rf "$scratch"
  if [ "$self_test_failures" -ne 0 ]; then
    say ""
    say "self-test: $self_test_failures of $self_test_cases cases FAILED"
    exit 1
  fi
  say ""
  say "self-test: $self_test_cases non-device cases OK"
  exit 0
}

[ "$self_test" -eq 1 ] && run_self_test

# ── the run ──────────────────────────────────────────────────────────────────

[ -n "$sender_device" ] || {
  say "--sender is required: this run drives real hardware, and choosing a device"
  say "on your behalf is not a decision it may make."
  exit 2
}
[ -n "$receiver_device" ] || {
  say "--receiver is required: this run drives real hardware, and choosing a device"
  say "on your behalf is not a decision it may make."
  exit 2
}
[ "$sender_device" != "$receiver_device" ] || {
  say "--sender and --receiver name the same device ($sender_device); two physical"
  say "endpoints are the whole point of this run."
  exit 2
}
if [ -n "$sender_peer_id" ] && [ "$sender_peer_id" = "$receiver_peer_id" ]; then
  say "--sender-peer-id and --receiver-peer-id carry the same device-directory id"
  say "($sender_peer_id). The sender selects the RECEIVING device's row and the"
  say "receiver opens the SENDING device's conversation, so the two ids name two"
  say "different devices by construction."
  exit 2
fi
[ -d "$project" ] || { say "no Xcode project at $project"; exit 1; }
command -v xcrun >/dev/null 2>&1 || { say "xcrun is required and is not on PATH"; exit 1; }

acceptance_begin

# Kept whatever happens — success is evidence too. `run_root` is the lib's
# throwaway scratch and dies with a passing run; nothing this run must keep
# lives there.
output="${output_root:-$repo_root/.relayium-device-inbox}/$run_tag"
mkdir -p "$output" || fail "cannot create the evidence directory $output"

# Unique to the run and bounded to the channel's own token set, because both
# ends publish the string they observed and this launcher compares them.
message="relayium-inbox-$run_tag"

say "== two-device Device Inbox acceptance, run $run_tag =="
say "-- evidence (kept whatever happens): $output"
say "-- precondition: BOTH devices must already be signed in, BY HAND, to the SAME"
say "   Relayium account. This harness holds no credential, takes no account"
say "   argument and reads no credential environment variable; a device without a"
say "   session SKIPS with the manual step quoted rather than failing obscurely."
say "-- precondition: the receiving device's Received folder must not already hold"
say "   \"$fixture_name\". The product refuses a taken name on commit"
say "   rather than overwrite; delete the previous brief in the Files app"
say "   (Relayium → Received) between runs. Nothing here deletes it for you."

# The grammar is proved before a device is touched, on every run: it is the one
# piece of this harness that acts on input from outside itself.
python3 "$channel" self-test >&2 || fail "the channel grammar self-test did not pass"

# ── the two devices, from ONE snapshot ───────────────────────────────────────
#
# One snapshot, read once, so both selectors are resolved against the same view
# of the world.
snapshot="$output/devices.json"
xcrun devicectl list devices --json-output "$snapshot" --quiet >/dev/null 2>&1 \
  || fail "could not list this Mac's devices. Is Xcode installed and are the devices paired?"

facts_sender="$(ios_read_device "$snapshot" "$sender_device" "--sender" "$project")"
facts_receiver="$(ios_read_device "$snapshot" "$receiver_device" "--receiver" "$project")"
sender_model="$(printf '%s' "$facts_sender" | cut -f2)"
receiver_model="$(printf '%s' "$facts_receiver" | cut -f2)"
sender_platform="$(printf '%s' "$facts_sender" | cut -f3)"
receiver_platform="$(printf '%s' "$facts_receiver" | cut -f3)"
sender_udid="$(printf '%s' "$facts_sender" | cut -f5)"
receiver_udid="$(printf '%s' "$facts_receiver" | cut -f5)"
sender_matched="$(printf '%s' "$facts_sender" | cut -f6)"
receiver_matched="$(printf '%s' "$facts_receiver" | cut -f6)"

for platform in "$sender_platform" "$receiver_platform"; do
  case "$platform" in
    iOS|"") ;;
    *) fail "this harness drives iOS devices; one of them reports platform '$platform'" ;;
  esac
done

# Two selector forms can name ONE device, and that is a reachable mistake
# precisely BECAUSE both forms are accepted.
ios_require_distinct_devices "$sender_udid" "$receiver_udid" \
  "$sender_matched" "$receiver_matched"

# Neither identifier is printed: a retained acceptance log has no use for a
# stable identifier of somebody's hardware.
say "-- SENDER:   $sender_model  (named by $sender_matched)"
say "-- RECEIVER: $receiver_model  (named by $receiver_matched)"

# ── build once ───────────────────────────────────────────────────────────────
#
# `build-for-testing` against the generic iOS destination, then
# `test-without-building` per device. `noninteractive` gives the build a
# session with no controlling terminal, so nothing it starts can prompt.
derived_data="$output/dd"
if [ "$skip_build" -eq 0 ]; then
  say "== building for testing (generic iOS device) =="
  noninteractive xcodebuild -project "$project" -scheme Relayium \
    -destination 'generic/platform=iOS' \
    -derivedDataPath "$derived_data" \
    "${xcodebuild_extra[@]+"${xcodebuild_extra[@]}"}" \
    build-for-testing >"$output/build.log" 2>&1 &
  build_pid=$!
  register_child build "$build_pid"
  build_status=0
  wait "$build_pid" || build_status=$?
  if [ "$build_status" -ne 0 ]; then
    say "-- build-for-testing failed ($build_status); its last 60 lines follow"
    tail -60 "$output/build.log" 2>/dev/null | sed 's/^/   /' >&2 || true
    fail "the app could not be built for the connected devices"
  fi
else
  [ -d "$derived_data" ] || fail "--skip-build was given but $derived_data does not exist"
  say "-- reusing the build in $derived_data"
fi

# ── running one role on one device ───────────────────────────────────────────
#
# Backgrounded and waited on rather than run in the foreground: bash does not
# service a trapped INT/TERM while waiting on a foreground child. The PID is
# registered first, so cleanup terminates it by exact PID — never by pattern.

declare -a role_pids=()
declare -a role_logs=()
declare -a role_names=()

events_for() {
  case "$1" in
    sender) printf '%s' "$sender_events" ;;
    receiver) printf '%s' "$receiver_events" ;;
  esac
}

# The extra diagnosis a failed run prints: which barrier each side reached,
# read out of the role logs and touching nothing else.
acceptance_extra_cleanup() {
  local i role role_log event line
  if [ "${completed:-0}" -ne 1 ]; then
    say "-- evidence kept: ${output:-<the evidence directory was never created>}"
    say "   per-role logs, .xcresult bundles and any retrieved bytes are retained there."
    say "-- device-side diagnosis: SKIPPED, deliberately and always. This harness"
    say "   collects only its own logs and the published choreography; it runs nothing"
    say "   that could ask you to authenticate, and nothing that changes a device."
  fi
  [ "${#role_names[@]}" -gt 0 ] || return 0
  say "-- published choreography, per role:"
  for i in "${!role_names[@]}"; do
    role="${role_names[$i]}"
    role_log="${role_logs[$i]}"
    line="   $role:"
    for event in $(events_for "$role"); do
      if ios_published "$channel" "$role_log" "$run_tag" "$role" "$event" "$marker" \
           >/dev/null 2>&1; then
        line="$line $event"
      fi
    done
    say "$line"
  done
}

# What reaches a device, and how: through `TEST_RUNNER_*`, which xcodebuild
# forwards to the test runner with the prefix stripped. The environment rather
# than argv on principle — argv on macOS is readable by every process this user
# runs. Nothing here is secret: a run tag, a role, a bounded run-unique
# message, the peer's directory id and two budgets. `--self-test` reads this
# body back and requires exactly that list, so an account, an address or a
# token could not be added without failing a case that runs with no device.
start_role() {
  # `$udid` is the RESOLVED hardware UDID and never the operator's selector.
  local udid="$1" role="$2" test_name="$3" peer_id="$4" role_log="$5"
  noninteractive env \
    TEST_RUNNER_RELAYIUM_DEVICE_INBOX_TAG="$run_tag" \
    TEST_RUNNER_RELAYIUM_DEVICE_INBOX_ROLE="$role" \
    TEST_RUNNER_RELAYIUM_DEVICE_INBOX_MESSAGE="$message" \
    TEST_RUNNER_RELAYIUM_DEVICE_INBOX_PEER_ID="$peer_id" \
    TEST_RUNNER_RELAYIUM_DEVICE_INBOX_PEER_BUDGET_SECONDS="$peer_budget" \
    TEST_RUNNER_RELAYIUM_DEVICE_INBOX_DELIVERY_BUDGET_SECONDS="$delivery_budget" \
    xcodebuild -project "$project" -scheme Relayium \
      -destination "platform=iOS,id=$udid" \
      -derivedDataPath "$derived_data" \
      -resultBundlePath "${role_log%.log}.xcresult" \
      -only-testing:"$suite/$test_name" \
      "${xcodebuild_extra[@]+"${xcodebuild_extra[@]}"}" \
      test-without-building >"$role_log" 2>&1 &
  local pid=$!
  register_child "$role" "$pid"
  role_pids+=("$pid")
  role_logs+=("$role_log")
  role_names+=("$role")
  say "   -- $role (pid $pid) → $(basename "$role_log")"
}

# The barrier, in this harness's own vocabulary. Same statuses as
# `ios_await_event`: 0 published, 1 the publisher exited, 2 the budget passed.
await_inbox_event() {
  local role_log="$1" role="$2" event="$3" pid="$4" limit="$5"
  ios_await_event "$channel" "$role_log" "$run_tag" "$role" "$event" \
    "$pid" "$limit" "$marker"
}

require_published() {
  local role_log="$1" role="$2" event="$3"
  ios_published "$channel" "$role_log" "$run_tag" "$role" "$event" "$marker" \
    >/dev/null \
    || fail "$role never published $event for run $run_tag; see $role_log"
}

published_value() {
  ios_published "$channel" "$1" "$run_tag" "$2" "$3" "$marker"
}

# Wait for every started role, or terminate them all by exact PID when the run
# exceeds its ceiling. A wedged runner holding a device is unbounded, and a
# harness that waits forever is a harness nobody can put in a queue.
await_roles() {
  local limit="$1" started=$SECONDS i alive status=0 failures=""
  while :; do
    alive=0
    for i in "${!role_pids[@]}"; do
      kill -0 "${role_pids[$i]}" 2>/dev/null && alive=1
    done
    [ "$alive" -eq 1 ] || break
    if [ $((SECONDS - started)) -ge "$limit" ]; then
      say "-- the run exceeded its ${limit}s ceiling; terminating its runners by PID"
      for i in "${!role_pids[@]}"; do
        kill -0 "${role_pids[$i]}" 2>/dev/null && kill -TERM "${role_pids[$i]}" 2>/dev/null || true
      done
      sleep 5
      for i in "${!role_pids[@]}"; do
        kill -0 "${role_pids[$i]}" 2>/dev/null && kill -KILL "${role_pids[$i]}" 2>/dev/null || true
      done
      status=1
      failures=" the run timed out"
      break
    fi
    sleep 2
  done
  for i in "${!role_pids[@]}"; do
    local role_status=0
    wait "${role_pids[$i]}" || role_status=$?
    if [ "$role_status" -ne 0 ]; then
      status=1
      failures="$failures ${role_names[$i]}(exit $role_status)"
      say "-- ${role_names[$i]} failed ($role_status); its last 60 lines follow"
      tail -60 "${role_logs[$i]}" 2>/dev/null | sed 's/^/   /' >&2 || true
    fi
  done
  [ "$status" -eq 0 ] || fail "this run did not pass:$failures"
}

# ── the received bytes, which no UI can prove ────────────────────────────────
#
# The receiving app renders a name and a state; neither describes the CONTENTS.
# So the file is read out of the receiving device's own app container — while
# the receiving app is still foreground, holding the committed state — and
# hashed against the constant above. `--domain-type appDataContainer` is
# read-only and reaches this app's container and nothing else; it works because
# the harness installed a development-signed build. If it cannot, the run FAILS
# with the exact command rather than quietly downgrading to the UI's own claim.
require_received_bytes() {
  local pulled="$output/received-live.bin" digest="" measured=""
  say "-- reading the committed brief out of the receiving device's app container,"
  say "   inside the receiver's fixed foreground holding window"
  if ! ios_container_file "$receiver_udid" "$bundle_id" "$fixture_container_path" \
       "$pulled" "$output/copy-from-receiver.json" \
       >"$output/copy-from-receiver.log" 2>&1; then
    say "   the copy failed; its output follows"
    sed 's/^/   /' "$output/copy-from-receiver.log" >&2 || true
    # "Not there" and "there under another name" are different findings that a
    # failed copy reports identically. Best-effort on purpose: a listing this
    # device will not give up must not replace a byte-level finding with a
    # harness error.
    say "   listing that container's Documents, read-only, to say what IS there:"
    ios_container_listing "$receiver_udid" "$bundle_id" Documents \
      "$output/listing-receiver.json" \
      >"$output/listing-receiver.log" 2>&1 || true
    sed 's/^/   /' "$output/listing-receiver.log" >&2 || true
    fail \
      "could not read $fixture_container_path out of $bundle_id on the receiving
     device while its app was foreground on the committed state. The receiving
     surface said it committed the brief, and this run will NOT report a pass on
     that claim alone. Reproduce with:
       xcrun devicectl device copy from --device <receiver> --domain-type appDataContainer
         --domain-identifier $bundle_id --source '$fixture_container_path' --destination /tmp/out"
  fi
  [ -f "$pulled" ] || fail \
    "the copy from the receiving device produced no plain file at $pulled"
  measured="$(wc -c <"$pulled" | tr -d ' ')"
  [ "$measured" = "$fixture_bytes" ] || fail \
    "the file read out of the receiving device is $measured bytes, not $fixture_bytes.
     Something committed under the right name, and it is not this run's brief."
  digest="$(ios_sha256 "$pulled")"
  [ "$digest" = "$fixture_sha256" ] || fail \
    "the bytes on the receiving device are not the bytes that were staged.
     expected $fixture_sha256
     received $digest
     Something committed under the right name and the right size, and it is not
     this run's brief. The pulled bytes are kept at $pulled."
  say "-- BYTES PROVED: the receiving device's own copy hashes to the staged digest"
}

# ── the one delivery ─────────────────────────────────────────────────────────
run_delivery() {
  local delivery_started=$SECONDS status=0 event
  local receiver_log="$output/receiver.log" sender_log="$output/sender.log"
  local receiver_pid="" sender_pid=""
  local sender_value="" receiver_value="" published_target="" published_peer=""
  local run_ceiling=$((peer_budget * 2 + delivery_budget * 2 + 1200)) run_left=0

  say ""
  say "== one delivery: $sender_model sends, $receiver_model receives =="

  # 1 — the receiver, alone, until the product's own status line reports it
  # ready. Its budget covers an install, a launch, Automation Mode, the session
  # restore and the roster wait, and `await_inbox_event` returns the moment the
  # runner dies, so a signed-out skip is reported in seconds.
  start_role "$receiver_udid" receiver "$receiver_test" "$receiver_peer_id" "$receiver_log"
  receiver_pid="${role_pids[0]}"
  say "-- waiting for the receiver to publish RECEIVING before the sender starts, so"
  say "   the two runners enable Automation Mode one at a time and the receiving app"
  say "   stays foreground from before the delivery until after the digest"
  status=0
  await_inbox_event "$receiver_log" receiver RECEIVING "$receiver_pid" \
    "$((peer_budget + 300))" >/dev/null || status=$?
  case "$status" in
    0) ;;
    1) fail "the receiver exited before it was receiving; the sender was never started,
     so no delivery was attempted against a device that was not there. A signed-out
     device skips with the manual sign-in step quoted; a device directory holding
     several rows with no --receiver-peer-id refuses rather than guesses. See
     $receiver_log" ;;
    2) fail "the receiver did not reach its receiving state within $((peer_budget + 300))s.
     Nothing was started on the sending device. See $receiver_log" ;;
  esac

  # 2 — only now the sender.
  start_role "$sender_udid" sender "$sender_test" "$sender_peer_id" "$sender_log"
  sender_pid="${role_pids[1]}"
  status=0
  await_inbox_event "$sender_log" sender TARGET "$sender_pid" \
    "$((peer_budget + 300))" >/dev/null || status=$?
  case "$status" in
    0) ;;
    1) fail "the sender exited before selecting a target row. A signed-out device skips
     with the manual step quoted; a directory holding several rows with no
     --sender-peer-id refuses rather than guesses. See $sender_log" ;;
    2) fail "the sender never selected a target row in the account's device directory
     within $((peer_budget + 300))s. See $sender_log" ;;
  esac

  # 3 — the receiver's HOLDING is the whole delivery observed from its end:
  # the suite publishes it only after this run's message and the exact staged
  # brief both committed into rows minted after the run began.
  status=0
  await_inbox_event "$receiver_log" receiver HOLDING "$receiver_pid" \
    "$((peer_budget + delivery_budget + delivery_budget))" >/dev/null || status=$?
  case "$status" in
    0) ;;
    1) fail "the receiver exited before both arrivals committed. If an earlier run left
     \"$fixture_name\" in Received, the commit was refused as a name
     conflict — delete the old file in the Files app (Relayium → Received) and
     rerun. Its own failure is reported with its log below; see $receiver_log" ;;
    2) fail "this run's message and brief did not both commit on the receiving device
     within $((peer_budget + delivery_budget + delivery_budget))s. See $receiver_log" ;;
  esac

  # 4 — the digest, inside the hold window. The receiver is foreground on the
  # committed state and stays there for its fixed window; nothing signals into
  # it and nothing shortens it.
  require_received_bytes

  # 5 — the window elapses on its own. 420s bounds the suite's own 300s clamp
  # ceiling plus teardown; the wait ends the moment DONE is published or the
  # runner dies. A failure here after a passing digest usually means the
  # receiving app left the foreground during its window, which the suite
  # asserts and names in its own log.
  status=0
  await_inbox_event "$receiver_log" receiver DONE "$receiver_pid" 420 \
    >/dev/null || status=$?
  case "$status" in
    0) ;;
    1) say "-- the receiver exited before publishing DONE; its failure is reported below" ;;
    2) fail "the receiver never finished its fixed holding window; see $receiver_log" ;;
  esac

  # 6 — both processes, to their natural ends, inside the run's ceiling.
  run_left=$((run_ceiling - (SECONDS - delivery_started)))
  [ "$run_left" -ge 60 ] || run_left=60
  await_roles "$run_left"

  # 7 — every required claim, from the logs both runners left behind. Each
  # event was published only after the assertion behind it held on that device.
  for event in $sender_events; do
    require_published "$sender_log" sender "$event"
  done
  for event in $receiver_events; do
    require_published "$receiver_log" receiver "$event"
  done

  # 8 — the comparisons neither end can make alone. Not "both ends said
  # something" but "both ends said THIS run's thing".
  sender_value="$(published_value "$sender_log" sender MESSAGE)"
  receiver_value="$(published_value "$receiver_log" receiver MESSAGE)"
  [ "$sender_value" = "$message" ] && [ "$receiver_value" = "$message" ] || fail \
    "the two ends disagree with this run about its message (sender: $sender_value,
     receiver: $receiver_value, this run: $message)."
  say "-- the run-unique message crossed exactly, asserted character for character"
  say "   inside a fresh timeline row at both ends"

  # NAME carries the run tag rather than the file name: the channel admits no
  # spaces, so each runner compares the rendered name in-process and publishes
  # the tag only if it matched exactly.
  sender_value="$(published_value "$sender_log" sender NAME)"
  receiver_value="$(published_value "$receiver_log" receiver NAME)"
  [ "$sender_value" = "$run_tag" ] && [ "$receiver_value" = "$run_tag" ] || fail \
    "a NAME event does not carry this run's tag (sender: $sender_value, receiver:
     $receiver_value). The event means \"the exact staged name rendered here\", so a
     foreign tag means a foreign run's claim."
  say "-- both surfaces rendered the exact staged file name, in this run"

  # FILE's value is the terminal state each role's own surface reached, and the
  # two roles must have reached DIFFERENT ones: committed is the receiver's,
  # saved is the sender's tracking poll observing that commit.
  sender_value="$(published_value "$sender_log" sender FILE)"
  receiver_value="$(published_value "$receiver_log" receiver FILE)"
  [ "$receiver_value" = "committed" ] || fail \
    "the receiver's FILE state is '$receiver_value', not 'committed'"
  [ "$sender_value" = "saved" ] || fail \
    "the sender's FILE state is '$sender_value', not 'saved'"

  # 9 — both halves named the right physical device. Each runner published the
  # directory id it ACTUALLY used; each is compared with the one this run was
  # given, so swapped ids fail with that diagnosis rather than proving a
  # delivery nobody asked for.
  published_target="$(published_value "$sender_log" sender TARGET)"
  published_peer="$(published_value "$receiver_log" receiver PEER)"
  if [ -n "$sender_peer_id" ]; then
    [ "$published_target" = "$sender_peer_id" ] || fail \
      "the sender selected row $published_target and --sender-peer-id named
     $sender_peer_id. Check that --sender-peer-id names the RECEIVING device's
     directory id; swapped with --receiver-peer-id, each end talks past the other."
  fi
  if [ -n "$receiver_peer_id" ]; then
    [ "$published_peer" = "$receiver_peer_id" ] || fail \
      "the receiver read conversation $published_peer and --receiver-peer-id named
     $receiver_peer_id. Check that --receiver-peer-id names the SENDING device's
     directory id; an older conversation is not evidence about this run."
  fi
  # The two ids name two different devices by construction — the sender's
  # target is the receiver, the receiver's peer is the sender — so equality
  # here means one device was both ends of this delivery, whatever the rest of
  # the choreography looked like.
  [ "$published_target" != "$published_peer" ] || fail \
    "the sender's selected row and the receiver's opened conversation are the SAME
     directory id ($published_target); one device cannot be both ends of a delivery."
  say "-- the sender selected $published_target; the receiver read $published_peer"

  role_pids=(); role_logs=(); role_names=()
}

run_delivery

say ""
say "== the delivery passed =="
say "-- evidence: $output"
say "-- proved: one real Device Inbox delivery on the production origin through two"
say "   manually established sessions — a run-unique message and the deterministic"
say "   brief, committed into fresh timeline rows on the receiver and reaching"
say "   \"Saved on the other device\" on the sender, with the received BYTES read"
say "   out of the receiving app's own container during its foreground hold and"
say "   hashed to the staged digest, and the receiver finishing only after its"
say "   fixed window elapsed on its own."
say "-- NOT proved by this run: the reverse direction (a second run, roles"
say "   exchanged, is the operator's deliberate step), background delivery, a"
say "   non-iOS sender, or the file surviving the receipt being dismissed."
completed=1
say "PASS"
