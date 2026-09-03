#!/bin/bash
# Two PHYSICAL iOS devices, each running the built app, completing real
# transfers to each other through their own UI.
#
# ── why this exists beside ios-ui-session-acceptance.sh ──────────────────────
#
# That script is simulator-only by construction, and its whole safety argument
# is a LOOPBACK origin. The app's acceptance seam (`--relayium-transfer-origin`)
# admits `127.0.0.1` and nothing else — `AppEnvironment.loopbackTransferOrigin`
# refuses even `localhost`, because a name is whatever the resolver says it is —
# and `UITestMode.allowsResidency` is `isActive && isLoopbackTransferOrigin` so
# an acceptance build can only ever be reachable inside a room that holds nobody
# else. A simulator shares the Mac's network stack, so that works there and
# cannot work here: `127.0.0.1` on the iPhone is the iPhone. Widening the
# allow-list to a LAN address would be exactly the weakening the seam exists to
# prevent, and `TransferOriginSeamTests` pins the expression in source.
#
# So this run adds no seam and widens none. It launches the app with **no
# `--relayium-transfer-origin` and no `--relayium-ui-testing`**, which resolves
# `productionBaseURL`, leaves `UITestMode.isActive` false, and takes
# `RelayiumApp`'s ordinary residency arm. The devices are reachable to each
# other here for the same reason and through the same code as for anybody who
# installed the app. Three Debug-only arguments remain — a deterministic 1,536
# byte fixture handed to the app-scoped direct selection, an emptied `Received`
# folder on the receiving device, and the `NSArgumentDomain` pin on the
# verification preference — and every one of them is `#if DEBUG` in `UITestMode`,
# absent from Release along with its parser.
#
# ── what it proves ───────────────────────────────────────────────────────────
#
#   * PROVES the NEARBY path between two real devices. Both join the production
#     code-less room; the connecting device finds the intended peer and REFUSES
#     an ambiguous roster — including when both devices announce the same family
#     name, which is a supported pair rather than a refusal; the unified `link/1`
#     is established; BOTH ends independently derive a short-authentication
#     string and this script requires them EQUAL before either confirms; a batch
#     staged before Connect is armed and released by that confirmation; the
#     receiving device presses the shipped Accept and its app reports the batch
#     committed; each side sends a run-unique message the other asserts by exact
#     text; and both return to a clean roster, the receiving device staying in
#     the room until the connecting one has verified its own roster and left.
#   * PROVES the PAIRING-CODE path between two real devices, as current `main`
#     actually composes it. `LINK_PAIRING_ROOM_SUPPORT` is false off macOS, so a
#     code on iOS establishes the LEGACY lane and not the workspace: one device
#     stages the fixture and mints a real code on the real server through Create,
#     this script reads those six digits out of that runner's bounded structured
#     output while it is still on the handoff screen, the other device types them
#     and Joins, both reach the legacy verification gate, both publish the code
#     they derived and this script requires them EQUAL, the transfer runs, and
#     the receiving device's own screen NAMES the file it wrote.
#   * PROVES a pairing-code TEXT session the same way, including the responder's
#     own Accept gate, with a run-unique message asserted in each direction.
#   * PROVES THE RECEIVED BYTES, TWICE, and the second time is not a repetition.
#     The file is pulled out of the receiving device's app container with
#     `devicectl device copy from` and hashed here. The digest it is compared
#     against is a constant in this script — 1,536 bytes of 0x52 — never a value
#     read back off the sending device, which is what makes it a comparison and
#     not an echo. It is taken:
#
#       1. LIVE, while the receiving runner is still on the screen that reported
#          the batch and has not yet pressed the product's own Done. That is the
#          read that says the transfer wrote the right bytes to the right place;
#       2. AFTER that runner has pressed Done and exited. That is the read that
#          says a file the product told a person they had received is still
#          theirs once they dismiss the receipt.
#
#     Both are required. Two reads rather than one because a single post-exit
#     read reports "never written", "unreadable once automation ended" and
#     "removed by the product on the way out" identically, and those are three
#     different findings owned by three different people. A run where the first
#     passes and the second fails names the third one exactly.
#   * RUNS BOTH DIRECTIONS by re-running each flow with the roles exchanged,
#     which is what makes the file half bidirectional.
#
# ── what it does NOT prove ───────────────────────────────────────────────────
#
#   * NOT a legacy `0.1.0` peer's fallback. Both ends here are this build, so
#     both announce `link/1` in the code-less room and are promoted to the
#     workspace.
#   * NOT a second batch on the same link. One post-connect batch is driven per
#     phase; the product's "as many files or folders as you like" claim is
#     asserted only as far as the first one and the surface that offers the next.
#   * NOT a file sent from INSIDE a live Nearby workspace. The workspace's own
#     post-connect file verb opens the system document browser and has no
#     injection seam — `RelayiumApp` gives the workspace a second, unseeded
#     `DirectSendSelection` on purpose — so the file half of Nearby is driven
#     through the pre-connect staging the copy under Connect describes.
#   * NOT the pairing code's own expiry, join link, or QR handoff.
#
# ── the one thing this run WRITES to a device, and where ─────────────────────
#
# A receiving role does not finish when its assertions are done. It publishes
# RECEIVED and then HOLDS — app running, completion still on screen — so the
# live read above can happen against a device in that state. This script tells
# it when to stop by writing ONE small file, carrying this run's tag, into the
# UI-TEST RUNNER's own data container: `RelayiumUITests-Runner`, the automation
# app `xcodebuild` installs and reinstalls on every run, and never the product's
# container, whose contents are the thing being proved.
#
# That is the whole of it. No product data, no device setting, no defaults
# domain, nothing outside that one automation sandbox. If the write cannot be
# made — no runner app in the build tree, or a device that refuses it — the run
# says so and the receiving role finishes on its own bounded ceiling instead.
# The byte checks are identical either way: a release that never arrives costs
# time and cannot make a missing or wrong file pass.
#
# ── how a phase is sequenced, and why one device sits idle at first ──────────
#
# ONE device is started at a time. The first runner is started alone, and the
# second is started only after the first has PUBLISHED that its app is up and
# waiting — the receiving device's READY on a Nearby phase, the minted code on a
# pairing one. So the second device will sit untouched for a while at the start
# of every phase. That is the harness working, not a stall.
#
# It is a handshake rather than a pause because starting a role starts an
# `xcodebuild` UI-test session, and that session has to enable Automation Mode on
# its device first. Two of them started in the same breath contend for it: one
# device times out enabling automation and the other then fails for the only
# reason left — the peer never launched — with the log naming the wrong device
# and no product claim tested at all. A fixed sleep would trade that for dead
# time on every run and still could not tell a slow install from a device that
# never came up.
#
# ── preconditions this script cannot create for you ──────────────────────────
#
#   * Both devices on the SAME network, unlocked, awake, and trusted by this Mac.
#     This script never changes a network setting, never reboots a device, never
#     erases or uninstalls one, and never toggles cellular.
#   * The device taking a GENERATING role must be SIGNED IN by hand, once, with a
#     verified address: creating a pairing code costs an account, joining one
#     does not. Because this run passes no `--relayium-ui-testing`, the app uses
#     the product's own keychain and that session persists across runs — which is
#     why this harness holds no credential, reads no credential environment
#     variable, and has nothing to redact from a log. Any plan will do. A device
#     without one SKIPS with the manual step quoted rather than timing out on a
#     button nobody drew.
#   * `--directions both` on a pairing flow therefore needs BOTH devices signed
#     in, because each takes the generating role once.
#
# ── the one thing this run DELETES, and where ────────────────────────────────
#
# Every receiving role launches with `--relayium-ui-testing-fresh-received-folder`
# unless `--keep-received` is passed. That empties the RELAYIUM APP'S OWN
# `Received` folder inside its own container on that device, and nothing else on
# the device is reachable from it. It is on by default because iOS has no folder
# picker for a download: the destination is fixed and the product REFUSES a name
# already taken, so without it the second run of a phase fails on the file the
# first run legitimately kept, and the digest check could not name the file it
# pulls back. The device and the effect are printed before every phase that uses
# it. Pass `--keep-received` to run against a device whose received files must
# survive; the run will then fail on the second execution of a phase, honestly.
#
# ── what a FAILED run collects, and what it will never do to collect it ──────
#
# A failed two-device run is exactly the moment somebody reaches for device-side
# diagnosis, and on macOS most of that reaching asks the operator to authenticate
# as an administrator. This harness does not: it is meant to be startable from a
# queue, and a run that stops halfway to draw a system authentication dialog is a
# run nobody can automate.
#
# On failure this run collects, and collects only:
#
#   * the last 60 lines of each role's own log, printed inline;
#   * the published-event choreography — which barrier each side reached — read
#     out of those same logs, touching nothing else;
#   * on a failed byte check ONLY, a read-only listing of the receiving app's own
#     container, because "the file is not there" and "the file is there under
#     another name" are different findings that a failed copy reports the same
#     way. It is best-effort: a listing that cannot be taken must not turn a
#     byte-level finding into a harness error;
#   * the per-role `.xcresult` bundles and full logs, KEPT rather than collected,
#     under the output directory the run names on its first line and names again
#     when it fails.
#
# It will not run a device-diagnosis, log-collection or system-configuration
# command, and it holds nothing that could answer an authentication dialog if one
# appeared. `--self-test` proves this by reading this file back and refusing any
# of those commands in executable position, so the property is checked by the
# same no-device gate that runs offline rather than by a reader's memory.
#
# ── usage ────────────────────────────────────────────────────────────────────
#
#   scripts/ios-device-pair-acceptance.sh --device-a <DEVICE> --device-b <DEVICE> \
#       [--flow nearby|pairing-files|pairing-text|pairing|all] \
#       [--directions both|a-to-b|b-to-a] \
#       [--output DIR] [--peer-budget SECONDS] [--phase-budget SECONDS] \
#       [--skip-build] [--keep-received] [--xcodebuild-arg ARG]...
#
#   scripts/ios-device-pair-acceptance.sh --self-test    # touches no device
#
# Both devices are REQUIRED and are never guessed: this script drives real
# hardware and picking a device on the operator's behalf is not a decision it
# may make. Any two of a three-device fleet may be named; the third is simply
# not addressed, and if it is in the same room it is REFUSED as an ambiguous
# roster rather than silently tolerated.
#
# ── naming a device: EITHER identifier Apple's own tools print ───────────────
#
# One physical iPhone has TWO identifiers, and the two tools an operator reaches
# for print DIFFERENT ones:
#
#   xcrun devicectl list devices        # the CoreDevice identifier — a UUID
#   xcodebuild -showdestinations \
#       -project apps/ios/Relayium.xcodeproj -scheme Relayium
#                                       # the HARDWARE UDID
#
# Both are accepted, in either case. Each selector is resolved against ONE
# `devicectl` snapshot and must match EXACTLY ONE device: zero matches and two
# matches are both refusals, there is no prefix match and no default. What is
# then passed to `xcodebuild -destination` is always the RESOLVED hardware UDID,
# whichever form was typed, because that is the value `platform=iOS,id=` is
# matched against. No real identifier is written down in this file or in the
# fixtures that drive its self-test.

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
project="$repo_root/apps/ios/Relayium.xcodeproj"
channel="$repo_root/scripts/lib/device_pair_channel.py"

# shellcheck source-path=SCRIPTDIR
# shellcheck source=lib/local-acceptance.sh
source "$repo_root/scripts/lib/local-acceptance.sh"
# shellcheck source-path=SCRIPTDIR
# shellcheck source=lib/ios-physical-device.sh
source "$repo_root/scripts/lib/ios-physical-device.sh"

# ── what the receiving device must end up holding ────────────────────────────
#
# `UITestMode.stagePendingFixture` writes exactly 1,536 bytes of 0x52 under
# `UITestMode.pendingFixtureName`, and every receive path on iOS lands in
# `ReceiveDestination.directory()` — `Documents/Received` inside the app's own
# container. The digest is written here rather than computed from the sending
# device, which is what makes the comparison independent of both ends.
#
# The app's bundle id, shared with macOS since iOS joined the one
# universal-purchase App Store record.
bundle_id="com.relayium.mac"
fixture_name="Relayium product brief.txt"
fixture_container_path="Documents/Received/$fixture_name"
fixture_sha256="1d71499ab7454d9955704333e6fddbded53e45217087bfdbaf529436765cfcfc"

# ── arguments ────────────────────────────────────────────────────────────────

device_a=""
device_b=""
flow="all"
directions="both"
output_root=""
peer_budget=300
phase_budget=1800
skip_build=0
keep_received=0
self_test=0
declare -a xcodebuild_extra=()

usage() {
  sed -n '2,/^set -euo/p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//; $d' >&2
  exit 2
}

while [ $# -gt 0 ]; do
  case "$1" in
    --device-a) device_a="${2:-}"; shift 2 ;;
    --device-b) device_b="${2:-}"; shift 2 ;;
    --flow) flow="${2:-}"; shift 2 ;;
    --directions) directions="${2:-}"; shift 2 ;;
    --output) output_root="${2:-}"; shift 2 ;;
    --peer-budget) peer_budget="${2:-}"; shift 2 ;;
    --phase-budget) phase_budget="${2:-}"; shift 2 ;;
    --skip-build) skip_build=1; shift ;;
    --keep-received) keep_received=1; shift ;;
    --xcodebuild-arg) xcodebuild_extra+=("${2:-}"); shift 2 ;;
    --self-test) self_test=1; shift ;;
    -h|--help) usage ;;
    *) say "unknown argument: $1"; usage ;;
  esac
done

case "$flow" in
  nearby|pairing-files|pairing-text|pairing|all) ;;
  *) say "--flow must be nearby, pairing-files, pairing-text, pairing or all"; usage ;;
esac
case "$directions" in
  both|a-to-b|b-to-a) ;;
  *) say "--directions must be both, a-to-b or b-to-a"; usage ;;
esac
case "$peer_budget" in ''|*[!0-9]*) say "--peer-budget must be whole seconds"; usage ;; esac
case "$phase_budget" in ''|*[!0-9]*) say "--phase-budget must be whole seconds"; usage ;; esac

# ── proving this harness WITHOUT touching a device ───────────────────────────
#
# Everything below runs with nothing plugged in. It is the gate that has to
# catch a defect a physical run would otherwise spend two devices, a build and
# twenty minutes discovering — and it exists because exactly that has happened:
# a selector compared against one tool's identifier and then spent on another's,
# and a start ordering that was asserted in a comment rather than in code.

self_test_fixture() {
  cat >"$1" <<'JSON'
{"result":{"devices":[
  {"identifier":"11111111-2222-3333-4444-555555555555",
   "deviceProperties":{"name":"Acceptance phone"},
   "hardwareProperties":{"udid":"00008130-000A1B2C3D4E5678","productType":"iPhone15,2",
                         "platform":"iOS"}},
  {"identifier":"66666666-7777-8888-9999-aaaaaaaaaaaa",
   "deviceProperties":{"name":"Acceptance tablet"},
   "hardwareProperties":{"udid":"00008103-001122334455667E","productType":"iPad14,3",
                         "platform":"iOS"}},
  {"identifier":"bbbbbbbb-cccc-dddd-eeee-ffffffffffff",
   "deviceProperties":{"name":"Acceptance tablet two"},
   "hardwareProperties":{"udid":"00008103-00AABBCCDDEEFF01","productType":"iPad14,5",
                         "platform":"iOS"}}
]}}
JSON
}

# One device listed TWICE under the same CoreDevice identifier. It must stay ONE
# match: `devicectl` can report a device over more than one transport, and a
# resolver that counted records rather than devices would refuse a perfectly
# ordinary connection as ambiguous.
self_test_duplicate_fixture() {
  cat >"$1" <<'JSON'
{"result":{"devices":[
  {"identifier":"11111111-2222-3333-4444-555555555555",
   "deviceProperties":{"name":"Acceptance phone"},
   "hardwareProperties":{"udid":"00008130-000A1B2C3D4E5678","productType":"iPhone15,2",
                         "platform":"iOS"}},
  {"identifier":"11111111-2222-3333-4444-555555555555",
   "deviceProperties":{"name":"Acceptance phone"},
   "hardwareProperties":{"udid":"00008130-000A1B2C3D4E5678","productType":"iPhone15,2",
                         "platform":"iOS"}}
]}}
JSON
}

# TWO different devices sharing one hardware UDID, which is what a stale or
# corrupted snapshot looks like. Refused rather than resolved to the first.
self_test_ambiguous_fixture() {
  cat >"$1" <<'JSON'
{"result":{"devices":[
  {"identifier":"11111111-2222-3333-4444-555555555555",
   "deviceProperties":{"name":"Acceptance phone"},
   "hardwareProperties":{"udid":"00008130-000A1B2C3D4E5678","productType":"iPhone15,2",
                         "platform":"iOS"}},
  {"identifier":"99999999-8888-7777-6666-555555555555",
   "deviceProperties":{"name":"Acceptance phone again"},
   "hardwareProperties":{"udid":"00008130-000A1B2C3D4E5678","productType":"iPhone15,4",
                         "platform":"iOS"}}
]}}
JSON
}

# A device with no hardware UDID at all. It cannot be an `xcodebuild`
# destination, so it is refused BEFORE a build rather than after one.
self_test_udidless_fixture() {
  cat >"$1" <<'JSON'
{"result":{"devices":[
  {"identifier":"11111111-2222-3333-4444-555555555555",
   "deviceProperties":{"name":"Half-paired phone"},
   "hardwareProperties":{"productType":"iPhone15,2","platform":"iOS"}}
]}}
JSON
}

# A derived-data tree holding the UI-test runner apps a build would have left in
# it. `none` is a tree that was built without a UI-test target, `two` is the
# ambiguity this resolver refuses, and `anonymous` is a runner app whose Info.plist
# declares no identifier at all.
#
# No real bundle identifier: `com.example.` is reserved for exactly this, and a
# fixture carrying the product's own would let a resolver that returned a
# hard-coded string pass.
self_test_runner_tree() {
  local shape="$2" products="$1/Build/Products/Debug-iphoneos"
  mkdir -p "$products"
  case "$shape" in
    none) return 0 ;;
    anonymous)
      mkdir -p "$products/RelayiumUITests-Runner.app"
      printf '%s\n' '<plist version="1.0"><dict/></plist>' \
        >"$products/RelayiumUITests-Runner.app/Info.plist"
      return 0 ;;
  esac
  mkdir -p "$products/RelayiumUITests-Runner.app"
  self_test_runner_plist "$products/RelayiumUITests-Runner.app/Info.plist" \
    "com.example.uitests.xctrunner"
  [ "$shape" = "two" ] || return 0
  mkdir -p "$products/SecondUITests-Runner.app"
  self_test_runner_plist "$products/SecondUITests-Runner.app/Info.plist" \
    "com.example.second.xctrunner"
}

self_test_runner_plist() {
  cat >"$1" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
<dict>
	<key>CFBundleIdentifier</key>
	<string>$2</string>
</dict>
</plist>
PLIST
}

# `status|identifier`, so a case asserts the refusal AND the value at once —
# the same shape `self_test_resolve` uses for a device selector.
self_test_runner_id() {
  local identifier="" status=0
  identifier="$(ios_ui_runner_bundle_id "$1")" || status=$?
  if [ "$status" -ne 0 ]; then printf '%s|' "$status"; return 0; fi
  printf '0|%s' "$identifier"
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

# Resolve a selector against a fixture and report `status|field`, so a case can
# assert the refusal AND the value with one expectation.
self_test_resolve() {
  local snapshot="$1" selector="$2" field="$3" facts="" status=0
  facts="$(ios_device_facts "$snapshot" "$selector")" || status=$?
  if [ "$status" -ne 0 ]; then printf '%s|' "$status"; return 0; fi
  printf '0|%s' "$(printf '%s' "$facts" | cut -f"$field")"
}

run_self_test() {
  local scratch devices duplicate ambiguous udidless log
  scratch="$(mktemp -d "${TMPDIR:-/tmp}/relayium-pair-selftest.XXXXXX")"
  devices="$scratch/devices.json"
  duplicate="$scratch/duplicate.json"
  ambiguous="$scratch/ambiguous.json"
  udidless="$scratch/udidless.json"
  log="$scratch/role.log"
  self_test_fixture "$devices"
  self_test_duplicate_fixture "$duplicate"
  self_test_ambiguous_fixture "$ambiguous"
  self_test_udidless_fixture "$udidless"

  say "== self-test: the grammar this harness reads from outside itself =="
  python3 "$channel" self-test >&2 \
    || { say "   FAIL the channel self-test did not pass"; self_test_failures=1; }

  say "== self-test: resolving ONE selector to ONE device =="
  # Either identifier form, in either case, resolves to the SAME hardware UDID —
  # which is the value `xcodebuild -destination` is matched against and the only
  # value this script ever passes to it.
  self_test_expect "a CoreDevice identifier resolves to the hardware UDID" \
    "0|00008130-000A1B2C3D4E5678" \
    "$(self_test_resolve "$devices" "11111111-2222-3333-4444-555555555555" 5)"
  self_test_expect "a hardware UDID resolves to itself" \
    "0|00008130-000A1B2C3D4E5678" \
    "$(self_test_resolve "$devices" "00008130-000A1B2C3D4E5678" 5)"
  self_test_expect "an upper-cased CoreDevice identifier still resolves" \
    "0|00008130-000A1B2C3D4E5678" \
    "$(self_test_resolve "$devices" "11111111-2222-3333-4444-555555555555" 5)"
  self_test_expect "a lower-cased hardware UDID still resolves" \
    "0|00008130-000A1B2C3D4E5678" \
    "$(self_test_resolve "$devices" "00008130-000a1b2c3d4e5678" 5)"
  self_test_expect "each form is reported as the form it was" \
    "0|its CoreDevice identifier" \
    "$(self_test_resolve "$devices" "11111111-2222-3333-4444-555555555555" 6)"
  self_test_expect "each form is reported as the form it was" \
    "0|its hardware UDID" \
    "$(self_test_resolve "$devices" "00008130-000A1B2C3D4E5678" 6)"
  self_test_expect "the announced family comes from the product type" \
    "0|iPhone" "$(self_test_resolve "$devices" "00008130-000A1B2C3D4E5678" 1)"
  self_test_expect "an iPad announces iPad" \
    "0|iPad" "$(self_test_resolve "$devices" "00008103-001122334455667E" 1)"

  # Never a default, never a prefix, never a first-connected.
  self_test_expect "an unknown selector matches nothing" \
    "3|" "$(self_test_resolve "$devices" "not-a-device" 5)"
  self_test_expect "an empty selector matches nothing" \
    "3|" "$(self_test_resolve "$devices" "" 5)"
  self_test_expect "a PREFIX of a real identifier matches nothing" \
    "3|" "$(self_test_resolve "$devices" "11111111" 5)"
  self_test_expect "one device listed twice is still one device" \
    "0|00008130-000A1B2C3D4E5678" \
    "$(self_test_resolve "$duplicate" "00008130-000A1B2C3D4E5678" 5)"
  self_test_expect "two devices sharing a UDID are refused" \
    "4|" "$(self_test_resolve "$ambiguous" "00008130-000A1B2C3D4E5678" 5)"
  self_test_expect "a device with no hardware UDID is refused before a build" \
    "5|" "$(self_test_resolve "$udidless" "11111111-2222-3333-4444-555555555555" 5)"

  say "== self-test: two selectors that name ONE device =="
  self_test_expect "the same device under BOTH forms is one device" \
    "same" \
    "$( [ "$(self_test_resolve "$devices" "11111111-2222-3333-4444-555555555555" 5)" \
        = "$(self_test_resolve "$devices" "00008130-000A1B2C3D4E5678" 5)" ] \
        && echo same || echo different)"
  self_test_expect "two genuinely different devices differ" \
    "different" \
    "$( [ "$(self_test_resolve "$devices" "00008130-000A1B2C3D4E5678" 5)" \
        = "$(self_test_resolve "$devices" "00008103-001122334455667E" 5)" ] \
        && echo same || echo different)"

  say "== self-test: how the two devices may be told apart =="
  self_test_expect "an iPhone and an iPad announce distinct names" \
    "distinct" "$(ios_peer_name_mode iPhone iPad)"
  self_test_expect "two iPads announce a shared name" \
    "shared" "$(ios_peer_name_mode iPad iPad)"
  self_test_expect "the third device of this fleet is an iPad too" \
    "0|iPad" "$(self_test_resolve "$devices" "00008103-00AABBCCDDEEFF01" 1)"

  say "== self-test: the start barrier, with no device anywhere =="
  # A publisher that is ALIVE and has published: the value comes back and the
  # loop returns immediately.
  ( sleep 60 ) & local live=$!
  printf '%s ffffffff nearby-resident READY ffffffff\n' "RELAYIUM-DEVICE-PAIR" >"$log"
  self_test_expect "an awaited event is returned when it is published" \
    "0|ffffffff" \
    "$(value="$(ios_await_event "$channel" "$log" ffffffff nearby-resident READY "$live" 6 2>/dev/null)" \
       && printf '0|%s' "$value" || printf '%s|' "$?")"
  # The OTHER role's line, on the same log, for the same event. Both Nearby
  # roles publish READY, so an event-only match would be opened by the very
  # runner the barrier exists to hold back.
  printf '%s ffffffff nearby-connector READY ffffffff\n' "RELAYIUM-DEVICE-PAIR" >"$log"
  self_test_expect "the other role's READY does not open this gate" \
    "2|" \
    "$(value="$(ios_await_event "$channel" "$log" ffffffff nearby-resident READY "$live" 4 2>/dev/null)" \
       && printf '0|%s' "$value" || printf '%s|' "$?")"
  # An earlier run's tag, likewise.
  printf '%s 0badcafe nearby-resident READY 0badcafe\n' "RELAYIUM-DEVICE-PAIR" >"$log"
  self_test_expect "a previous run's line does not open this gate" \
    "2|" \
    "$(value="$(ios_await_event "$channel" "$log" ffffffff nearby-resident READY "$live" 4 2>/dev/null)" \
       && printf '0|%s' "$value" || printf '%s|' "$?")"
  kill "$live" 2>/dev/null || true
  wait "$live" 2>/dev/null || true
  # A publisher that has EXITED. It will never publish, so the gate must report
  # that in seconds rather than waiting out a budget that could be minutes.
  #
  # The budget is 120 rather than the several minutes a real phase uses, and the
  # size is a deliberate trade rather than a weakening. 120s is already two
  # orders of magnitude more than the ~0s a correct gate takes, so it proves the
  # property; and it BOUNDS this case, which matters because the failure it
  # detects is "the gate waits" — a broken gate makes this line consume the whole
  # budget, so a larger one would turn a caught defect into a self-test that
  # looks hung. Measured: this was 600 first, and a mutation battery that
  # correctly killed the defect took ten minutes to say so.
  ( exit 0 ) & local dead=$!
  wait "$dead" 2>/dev/null || true
  : >"$log"
  self_test_expect "a publisher that exited is not waited out" \
    "1|" \
    "$(value="$(ios_await_event "$channel" "$log" ffffffff nearby-resident READY "$dead" 120 2>/dev/null)" \
       && printf '0|%s' "$value" || printf '%s|' "$?")"

  say "== self-test: this file cannot prompt the operator for anything =="
  local hits
  hits="$(ios_forbidden_command_hits "${BASH_SOURCE[0]}")"
  self_test_expect "no credential-seeking or destructive command in this file" \
    "" "$hits"
  hits="$(ios_forbidden_command_hits "$repo_root/scripts/lib/ios-physical-device.sh")"
  self_test_expect "none in the library either" "" "$hits"
  # Every `xcodebuild` this file starts goes through `noninteractive`, which
  # gives it a session with no controlling terminal. A bare one would inherit
  # this shell's, and Apple's own failure collection has reached for `sudo`
  # underneath it. The count is asserted as well as the bare count, so "0 bare"
  # from a file that launches nothing cannot pass.
  # Two launch sites and no more: the one `build-for-testing`, and the one
  # `start_role` every role of every phase goes through. A third would be a
  # launch that had not been reasoned about.
  self_test_expect "every xcodebuild launch is detached from the terminal" \
    "2 launches, 0 bare" "$(ios_xcodebuild_launch_census "${BASH_SOURCE[0]}")"
  # The one recursive delete this file has, pinned by target.
  # shellcheck disable=SC2016  # the single quotes are the point: this is the
  # literal text the scan must produce, not an expression to expand.
  self_test_expect "the only recursive delete targets this run's own scratch" \
    'rm -rf "$scratch";' "$(ios_recursive_delete_sites "${BASH_SOURCE[0]}")"
  # Every `devicectl` shape either file uses, pinned as a set rather than left
  # to a ban list. The ban list answers "does this erase a device"; this answers
  # "does this do anything to a device that has not been reasoned about", which
  # is the question a harness that grows a new capability actually faces. Three
  # shapes, and the only one that WRITES goes to the automation runner's own
  # container — see `release_receiver`.
  self_test_expect "the launcher uses only the device shapes it documents" \
    "device copy from;list devices;" \
    "$(ios_devicectl_shapes "${BASH_SOURCE[0]}")"
  self_test_expect "the library uses only the device shapes it documents" \
    "device copy from;device copy to;device info files;list devices;" \
    "$(ios_devicectl_shapes "$repo_root/scripts/lib/ios-physical-device.sh")"

  say "== self-test: releasing a receiving role, with no device anywhere =="
  # The release file's name is composed by the channel and by the runner
  # independently. A disagreement would leave every receiving role holding to its
  # ceiling while this script reported that it had released it — slower on every
  # run, and silent, which is why the name is proved here rather than trusted.
  self_test_expect "the release file carries this run's tag and the role" \
    "relayium-device-pair-release-ffffffff-pair-file-joiner" \
    "$(python3 "$channel" release-name --tag ffffffff --role pair-file-joiner)"
  self_test_expect "a malformed tag composes no release file name at all" \
    "2" "$(python3 "$channel" release-name --tag "has space" --role x >/dev/null 2>&1; echo $?)"
  # The runner app is READ out of the build tree rather than composed from the
  # project's bundle identifier plus Xcode's `.xctrunner` suffix: the suffix is
  # Xcode's convention, and a guess would write a release into a container that
  # does not exist while reporting the runner released.
  #
  # Four separate trees rather than one that is built up and torn down. A case
  # that deleted its predecessor's fixture would be the second recursive delete
  # in this file, and the scan above pins that there is exactly one.
  self_test_runner_tree "$scratch/dd-one" one
  self_test_runner_tree "$scratch/dd-two" two
  self_test_runner_tree "$scratch/dd-none" none
  self_test_runner_tree "$scratch/dd-anonymous" anonymous
  self_test_expect "the runner's bundle identifier is read off the built app" \
    "0|com.example.uitests.xctrunner" "$(self_test_runner_id "$scratch/dd-one")"
  self_test_expect "two runner apps are refused rather than resolved to the first" \
    "4|" "$(self_test_runner_id "$scratch/dd-two")"
  self_test_expect "no runner app at all is refused" \
    "3|" "$(self_test_runner_id "$scratch/dd-none")"
  self_test_expect "a runner app declaring no identifier is refused" \
    "5|" "$(self_test_runner_id "$scratch/dd-anonymous")"

  say "== self-test: the phase plan =="
  # The plan is a pure function of --flow and --directions, so a run cannot
  # quietly drive fewer phases than it was asked for — which is the failure a
  # green log would not show.
  self_test_expect "all/both drives six phases" \
    "nearby:a-to-b nearby:b-to-a pairing-files:a-to-b pairing-files:b-to-a pairing-text:a-to-b pairing-text:b-to-a" \
    "$(phase_plan all both)"
  self_test_expect "one flow, one direction, is one phase" \
    "nearby:a-to-b" "$(phase_plan nearby a-to-b)"
  self_test_expect "pairing means both pairing flows" \
    "pairing-files:b-to-a pairing-text:b-to-a" "$(phase_plan pairing b-to-a)"

  say "== self-test: which device receives, and is therefore reset and hashed =="
  self_test_expect "a-to-b receives on B" "b" "$(receiving_side nearby a-to-b)"
  self_test_expect "b-to-a receives on A" "a" "$(receiving_side nearby b-to-a)"
  self_test_expect "a pairing files phase receives on the joining side" \
    "b" "$(receiving_side pairing-files a-to-b)"
  self_test_expect "a text phase receives no file at all" \
    "" "$(receiving_side pairing-text a-to-b)"

  say "== self-test: which ROLE receives, and is therefore held alive and released =="
  self_test_expect "the Nearby resident receives in both directions" \
    "nearby-resident nearby-resident" \
    "$(receiving_role nearby) $(receiving_role nearby)"
  self_test_expect "the pairing joiner receives in both directions" \
    "pair-file-joiner pair-file-joiner" \
    "$(receiving_role pairing-files) $(receiving_role pairing-files)"
  self_test_expect "a text phase has no receiving role" "" "$(receiving_role pairing-text)"
  # The two rules must agree about whether a phase receives AT ALL. They are
  # separate functions because they answer different questions — which device,
  # which role — and a phase where one says "yes" and the other "no" would
  # either skip the byte check or ask for a role that is not in the phase.
  local plan_entry side role agreement=""
  for plan_entry in $(phase_plan all both); do
    side="$(receiving_side "${plan_entry%%:*}" "${plan_entry##*:}")"
    role="$(receiving_role "${plan_entry%%:*}")"
    if [ -n "$side" ] && [ -n "$role" ]; then agreement="$agreement both"
    elif [ -z "$side" ] && [ -z "$role" ]; then agreement="$agreement neither"
    else agreement="$agreement DISAGREE"; fi
  done
  self_test_expect "every phase agrees about whether it receives a file" \
    " both both both both neither neither" "$agreement"
  # Executed rather than read: this is the one expression in this file that
  # would be a bash 3.2 "bad substitution" if it were written the obvious way,
  # and `bash -n` cannot see that.
  self_test_expect "a side is reported to the operator as A or B" \
    "A B" "$(side_label a) $(side_label b)"

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

# ── the phase plan, as a pure function ───────────────────────────────────────
#
# Written as a function rather than inline so `--self-test` can execute it. A
# plan that silently dropped a flow would produce a green run that proved less
# than it was asked to, and a log nobody would read as wrong.
phase_plan() {
  local want="$1" want_directions="$2" flows="" out="" flow_name direction
  case "$want" in
    nearby) flows="nearby" ;;
    pairing-files) flows="pairing-files" ;;
    pairing-text) flows="pairing-text" ;;
    pairing) flows="pairing-files pairing-text" ;;
    all) flows="nearby pairing-files pairing-text" ;;
  esac
  for flow_name in $flows; do
    for direction in a-to-b b-to-a; do
      case "$want_directions" in
        both) ;;
        "$direction") ;;
        *) continue ;;
      esac
      out="$out $flow_name:$direction"
    done
  done
  printf '%s' "${out# }"
}

# "a" as the operator reads it in `--device-a`.
#
# `${side^^}` would be the obvious form and is a bash 4 feature: macOS ships
# bash 3.2 as `/bin/bash`, where it is a RUNTIME "bad substitution" that `bash
# -n` does not catch. So it is a function, and the self-test executes it — which
# is the only way an offline gate can hold this file to the shell it is actually
# started with.
side_label() {
  printf '%s' "$1" | tr 'ab' 'AB'
}

# Which side of a phase WRITES a received file — the side whose `Received`
# folder is emptied first and whose container is read back afterwards. Empty for
# a phase that transfers no file.
receiving_side() {
  case "$1" in
    nearby|pairing-files)
      if [ "$2" = "a-to-b" ]; then printf 'b'; else printf 'a'; fi ;;
    *) printf '' ;;
  esac
}

# Which ROLE of a phase writes that file, and is therefore the one that holds its
# completed state while the container is read. Empty for a phase that transfers
# no file.
#
# A function of the flow alone, and deliberately: reversing a direction swaps
# which DEVICE plays a role, never which role receives. The Nearby resident
# receives in both directions and the pairing joiner receives in both, so a rule
# written in terms of the direction would have two ways to be right and one way
# to be quietly wrong. `run_phase` cross-checks this against `receiving_side` at
# runtime, so the two cannot drift apart in only one of them.
receiving_role() {
  case "$1" in
    nearby) printf 'nearby-resident' ;;
    pairing-files) printf 'pair-file-joiner' ;;
    *) printf '' ;;
  esac
}

[ "$self_test" -eq 1 ] && run_self_test

# ── the run ──────────────────────────────────────────────────────────────────

[ -n "$device_a" ] && [ -n "$device_b" ] || {
  say "--device-a and --device-b are both required: this run drives real hardware"
  say "and choosing a device on your behalf is not a decision it may make."
  usage
}
[ -d "$project" ] || fail "no Xcode project at $project"
command -v xcrun >/dev/null 2>&1 || fail "xcrun is required and is not on PATH"

acceptance_begin

output="${output_root:-$repo_root/.relayium-device-pair/$run_tag}"
mkdir -p "$output" || fail "cannot create the output directory $output"
say "== two-device iOS acceptance, run $run_tag =="
say "-- artifacts (kept whatever happens): $output"

# The grammar is proved before a device is touched, on every run and not only
# under `--self-test`: it is the one piece of this harness that acts on input
# from outside itself, and the pairing code it extracts becomes input to a
# second process.
python3 "$channel" self-test >&2 || fail "the channel grammar self-test did not pass"

# ── the two devices, from ONE snapshot ───────────────────────────────────────
#
# One snapshot, read once, so both selectors are resolved against the same view
# of the world. Two separate `devicectl` calls could disagree about a device that
# arrived or left between them, and the refusals below would then be about
# different rooms.
snapshot="$output/devices.json"
xcrun devicectl list devices --json-output "$snapshot" --quiet >/dev/null 2>&1 \
  || fail "could not list this Mac's devices. Is Xcode installed and are the devices paired?"

facts_a="$(ios_read_device "$snapshot" "$device_a" "--device-a" "$project")"
facts_b="$(ios_read_device "$snapshot" "$device_b" "--device-b" "$project")"
family_a="$(printf '%s' "$facts_a" | cut -f1)"
family_b="$(printf '%s' "$facts_b" | cut -f1)"
model_a="$(printf '%s' "$facts_a" | cut -f2)"
model_b="$(printf '%s' "$facts_b" | cut -f2)"
platform_a="$(printf '%s' "$facts_a" | cut -f3)"
platform_b="$(printf '%s' "$facts_b" | cut -f3)"
udid_a="$(printf '%s' "$facts_a" | cut -f5)"
udid_b="$(printf '%s' "$facts_b" | cut -f5)"
matched_a="$(printf '%s' "$facts_a" | cut -f6)"
matched_b="$(printf '%s' "$facts_b" | cut -f6)"

for platform in "$platform_a" "$platform_b"; do
  case "$platform" in
    iOS|"") ;;
    *) fail "this harness drives iOS devices; one of them reports platform '$platform'" ;;
  esac
done

# Two selector forms can name ONE device, and that is a reachable mistake
# precisely BECAUSE both forms are accepted.
ios_require_distinct_devices "$udid_a" "$udid_b" "$matched_a" "$matched_b"

# What an operator needs to see is which physical thing took which side. Neither
# identifier is printed: they are not secret, but a retained acceptance log has
# no use for a stable identifier of somebody's hardware, and the form each
# selector matched is what actually explains a resolution that accepted two
# spellings.
say "-- A: $model_a  announces \"$family_a\"  (named by $matched_a)"
say "-- B: $model_b  announces \"$family_b\"  (named by $matched_b)"
peer_name_mode="$(ios_peer_name_mode "$family_a" "$family_b")"
if [ "$peer_name_mode" = "shared" ]; then
  say "-- both devices announce \"$family_a\", so a roster row's NAME identifies nothing."
  say "   The room must hold exactly one selectable device, and the proof that the two"
  say "   ends are on the same connection is the verification code each derives alone."
else
  say "-- the two devices announce different names, so a roster row's name is evidence"
  say "   about which device it is — and is required to be the peer's."
fi

# ── build once ───────────────────────────────────────────────────────────────
#
# `build-for-testing` against the generic iOS destination, then
# `test-without-building` per device: the alternative — a full `test` per device
# per phase — rebuilds the app up to twelve times for one run.
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

# ── the automation app a holding receiving role is released through ──────────
#
# Read off the built product, once, before any device is driven. Not having it
# is NOT fatal: a receiving role that is never released finishes on its own
# bounded ceiling, and both byte checks are taken either way. What would be
# unacceptable is discovering it mid-phase, so it is resolved and reported here.
runner_bundle_id=""
if runner_bundle_id="$(ios_ui_runner_bundle_id "$derived_data")"; then
  say "-- a receiving role will be released through its own automation container"
  say "   ($runner_bundle_id). That is the only thing this run writes to a device."
else
  runner_bundle_id=""
  say "-- no single UI-test runner app under $derived_data, so a receiving role cannot be"
  say "   released and will hold its completed state for the full ${peer_budget}s ceiling."
  say "   Both byte checks are unchanged; the run is slower, not weaker."
fi

# ── running one role on one device ───────────────────────────────────────────
#
# Backgrounded and waited on rather than run in the foreground: bash does not
# service a trapped INT/TERM while waiting on a FOREGROUND child, so a launcher
# that ran `xcodebuild` in the foreground would ignore a SIGTERM for the whole of
# a minutes-long run and leave both runners going. The PID is registered first,
# so cleanup terminates it by exact PID like every other child — never by
# pattern.

declare -a role_pids=()
declare -a role_logs=()
declare -a role_names=()
phase_out=""

# The extra diagnosis a failed phase prints: which barrier each side reached,
# read out of the role logs and touching nothing else.
acceptance_extra_cleanup() {
  local i
  [ "${#role_names[@]}" -gt 0 ] || return 0
  say "-- published choreography, per role:"
  for i in "${!role_names[@]}"; do
    local role="${role_names[$i]}" log="${role_logs[$i]}" event line
    line="   $role:"
    for event in READY PAIRING-CODE SAS RECEIVED HOLDING; do
      if ios_published "$channel" "$log" "$run_tag" "$role" "$event" >/dev/null 2>&1; then
        line="$line $event"
      fi
    done
    say "$line"
  done
}

start_role() {
  # `$udid` is the RESOLVED hardware UDID and never the operator's selector:
  # `platform=iOS,id=` is matched against that value, and `ios_read_device` is
  # the only thing that produces it.
  local udid="$1" role="$2" test_name="$3" peer_name="$4" message="$5" \
        peer_message="$6" pairing_code="$7" log="$8"

  # Through `TEST_RUNNER_*`, which xcodebuild forwards to the test runner with
  # the prefix stripped. The environment rather than argv on principle: argv on
  # macOS is readable by every process this user runs. Nothing here is secret — a
  # run tag, a role, a device family name, a run-unique message and six public
  # digits — and it travels this way anyway, because the rule is worth more than
  # the exception.
  #
  # `noninteractive env …` rather than `env …`: this is the launch that can end
  # with `Password:` on the operator's terminal when a test fails. `execvp`
  # replaces the shim in place, so `$!` still names `xcodebuild` and cleanup
  # still kills it by exact PID.
  noninteractive env \
    TEST_RUNNER_RELAYIUM_DEVICE_PAIR_TAG="$run_tag" \
    TEST_RUNNER_RELAYIUM_DEVICE_PAIR_ROLE="$role" \
    TEST_RUNNER_RELAYIUM_DEVICE_PAIR_PEER_NAME="$peer_name" \
    TEST_RUNNER_RELAYIUM_DEVICE_PAIR_PEER_NAME_MODE="$peer_name_mode" \
    TEST_RUNNER_RELAYIUM_DEVICE_PAIR_MESSAGE="$message" \
    TEST_RUNNER_RELAYIUM_DEVICE_PAIR_PEER_MESSAGE="$peer_message" \
    TEST_RUNNER_RELAYIUM_DEVICE_PAIR_PAIRING_CODE="$pairing_code" \
    TEST_RUNNER_RELAYIUM_DEVICE_PAIR_PEER_BUDGET_SECONDS="$peer_budget" \
    TEST_RUNNER_RELAYIUM_DEVICE_PAIR_KEEP_RECEIVED="$keep_received" \
    xcodebuild -project "$project" -scheme Relayium \
      -destination "platform=iOS,id=$udid" \
      -derivedDataPath "$derived_data" \
      -resultBundlePath "${log%.log}.xcresult" \
      -only-testing:"RelayiumUITests/DevicePairUITests/$test_name" \
      "${xcodebuild_extra[@]+"${xcodebuild_extra[@]}"}" \
      test-without-building >"$log" 2>&1 &
  local pid=$!
  register_child "$role" "$pid"
  role_pids+=("$pid")
  role_logs+=("$log")
  role_names+=("$role")
  # The identifier is deliberately absent: the log's own name says which role
  # this is, the phase header says which device plays it, and the PID is what
  # cleanup actually uses.
  say "   -- $role (pid $pid) → $(basename "$log")"
}

# Wait for every started role, or terminate them all when the phase runs out of
# time. Bounded on purpose: a wedged runner holding a device is unbounded, and a
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
      say "-- the phase exceeded its ${limit}s ceiling; terminating its runners by PID"
      for i in "${!role_pids[@]}"; do
        kill -0 "${role_pids[$i]}" 2>/dev/null && kill -TERM "${role_pids[$i]}" 2>/dev/null || true
      done
      sleep 5
      for i in "${!role_pids[@]}"; do
        kill -0 "${role_pids[$i]}" 2>/dev/null && kill -KILL "${role_pids[$i]}" 2>/dev/null || true
      done
      status=1
      failures=" the phase timed out"
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
  [ "$status" -eq 0 ] || fail "this phase did not pass:$failures"
}

reset_roles() {
  role_pids=(); role_logs=(); role_names=(); phase_out=""
}

# ── the identification neither runner can make ───────────────────────────────
#
# Each end derives its short-authentication string from its OWN handshake on its
# own hardware, and neither test process can see the other's. Two independent
# derivations producing one string is the evidence a roster label, a device name
# or a matching file size cannot carry: it says both ends hold the same key,
# rather than that something arrived.
#
# **The value is not printed on the success path.** It is public by construction
# — people read it aloud to each other — but a retained acceptance log has no use
# for it, and on a pairing phase it is six digits sitting beside a phase whose
# own six digits are deliberately never logged either. A MISMATCH prints both,
# because at that point the two values are the finding.
require_equal_sas() {
  local a_log="$1" a_role="$2" b_log="$3" b_role="$4" a b
  a="$(ios_published "$channel" "$a_log" "$run_tag" "$a_role" SAS)" \
    || fail "$a_role published no verification code, so the two ends were never compared"
  b="$(ios_published "$channel" "$b_log" "$run_tag" "$b_role" SAS)" \
    || fail "$b_role published no verification code, so the two ends were never compared"
  [ "$a" = "$b" ] || fail \
    "the two devices derived DIFFERENT verification codes ($a on $a_role, $b on $b_role).
     They are not on the same connection — whatever each of them reached, it was not the
     other one."
  say "-- both devices independently derived the SAME verification code"
}

# ── the received bytes, which no UI can prove ────────────────────────────────
#
# The receiving app renders what it committed and the receiving test asserts it.
# Neither can describe the CONTENTS: a receipt of a name and a size passes for a
# receiver that wrote the right number of wrong bytes. So the file is read out of
# the receiving device's own app container and hashed against a constant this
# script holds independently of both devices.
#
# `--domain-type appDataContainer` is read-only and reaches this app's container
# and nothing else. It works because the harness installed a development-signed
# build; if it ever cannot, the run FAILS with the exact command rather than
# quietly downgrading to the UI's own claim.
#
# ── taken TWICE, and the second time is a different claim ────────────────────
#
# `when` is `live` or `after-exit`, and the two are not a retry:
#
#   * `live` runs while the receiving runner is still on the screen that named
#     the file and has NOT pressed the product's own Done. It answers "did the
#     transfer write the right bytes to the right place";
#   * `after-exit` runs once that runner has pressed Done and gone. It answers
#     "does a file the product told somebody they received survive them
#     dismissing the receipt" — which is a promise the product makes to a person
#     and not a property of this harness.
#
# Both must pass. The pair is what stops one failed read standing for three
# different findings; `run_phase` says which one failed and what that means.
require_received_bytes() {
  local udid="$1" side="$2" when="$3" earlier="$4"
  # A SECOND `local`, and not a continuation of the one above: bash expands every
  # word of a `local` command before performing any of its assignments, so a
  # `pulled=…$side…` written up there would interpolate the OUTER `side` — empty
  # — and both directions of a `--directions both` run would write their pulled
  # bytes over one file with a meaningless name. shellcheck SC2318 is what
  # caught it.
  local pulled="$phase_out/received-$side-$when.bin" digest="" attribution=""
  # What a failure MEANS, composed from what has already been established rather
  # than from which read this is. A post-exit read that fails after a live read
  # passed is not "the file is missing": it is the same file, correct minutes
  # earlier, gone after one product action.
  case "$when-$earlier" in
    live-*) attribution="The receiving app said it committed the batch and was still
     running, holding that state, when this read was taken. So the bytes are not there at
     all: this is not a container that became unreadable once automation ended." ;;
    after-exit-verified) attribution="These exact bytes WERE on this device and hashed
     correctly minutes ago, while the receiving app was alive and still showing the
     completion. Between then and now the only thing that happened is the receiving
     runner pressing the product's own Done and the app exiting. A file a person was told
     they had received must survive them dismissing the receipt, so this is a data-loss
     finding in the product's completion teardown — not a harness artifact and not a
     container lifecycle question. Preserve this run's artifacts." ;;
    *) attribution="The receiving app said it committed the batch, and
     this run will NOT report a pass on the strength of that claim alone." ;;
  esac
  say "-- reading the received file out of device $side's app container ($when)"
  if ! ios_container_file "$udid" "$bundle_id" "$fixture_container_path" "$pulled" \
        "$phase_out/copy-from-$side-$when.json" \
        >"$phase_out/copy-from-$side-$when.log" 2>&1; then
    say "   the copy failed; its output follows"
    sed 's/^/   /' "$phase_out/copy-from-$side-$when.log" >&2 || true
    # "Not there" and "there under another name" are different findings that a
    # failed copy reports identically, and only one of them is answered by
    # looking. Best-effort on purpose: a listing this device will not give up
    # must not replace a byte-level finding with a harness error.
    say "   listing that container's Documents, read-only, to say what IS there:"
    ios_container_listing "$udid" "$bundle_id" Documents \
      "$phase_out/listing-$side-$when.json" \
      >"$phase_out/listing-$side-$when.log" 2>&1 || true
    sed 's/^/   /' "$phase_out/listing-$side-$when.log" >&2 || true
    fail \
      "could not read $fixture_container_path out of $bundle_id on device $side ($when).
     $attribution
     Reproduce with:
       xcrun devicectl device copy from --device <$side> --domain-type appDataContainer \\
         --domain-identifier $bundle_id --source '$fixture_container_path' --destination /tmp/out"
  fi
  # `copy from` writes the file INTO the destination when the destination is a
  # directory and AS the destination otherwise; the destination here does not
  # exist, so it is the file. A directory would mean the tool behaved
  # differently from what this depends on, and that is a failure rather than a
  # search.
  [ -f "$pulled" ] || fail \
    "the copy from device $side produced no plain file at $pulled"
  digest="$(ios_sha256 "$pulled")"
  [ "$digest" = "$fixture_sha256" ] || fail \
    "the bytes on device $side are not the bytes that were staged ($when).
     expected $fixture_sha256
     received $digest
     $attribution"
  say "-- the received bytes hash to the staged file's digest ($when)"
}

# ── letting a holding receiving role finish ──────────────────────────────────
#
# The receiving runner is deliberately still alive: it published RECEIVED and
# then stopped, so the live read above happened against a device in the state the
# product reached. This is what tells it to go on and press Done.
#
# One file, carrying this run's tag, into the UI-TEST RUNNER's own container.
# Never the product's — that container's contents are the thing being proved, and
# harness state has no business in it.
#
# Every failure here is reported and survived rather than fatal. The runner's own
# ceiling is the backstop, the byte checks do not depend on this, and turning a
# release that could not be written into a failed phase would report a slow
# handshake as a product finding.
release_receiver() {
  local udid="$1" role="$2" name="" body="$phase_out/release-$2"
  if [ -z "$runner_bundle_id" ]; then
    say "-- no automation container to release $role through; it will hold to its ceiling"
    return 0
  fi
  name="$(python3 "$channel" release-name --tag "$run_tag" --role "$role" 2>/dev/null)" || {
    say "-- refusing to compose a release name for $role; it will hold to its ceiling"
    return 0
  }
  printf '%s' "$run_tag" >"$body" || return 0
  if ios_container_put "$udid" "$runner_bundle_id" "$body" "Documents/$name" \
       "$phase_out/release-$role.json" >"$phase_out/release-$role.log" 2>&1; then
    say "-- released $role: its bytes are verified and it may finish through the shipped Done"
  else
    say "-- could not write the release into $role's own automation container; it will hold"
    say "   for the full ${peer_budget}s ceiling and then finish. See release-$role.log"
  fi
}

# ── one phase ────────────────────────────────────────────────────────────────
#
# Every phase has the same shape and the same barrier, which is why it is one
# function: start the publishing role alone, wait for the exact fact that says
# its app is up and holding what the other side needs, start the second role,
# wait for both, then make the two cross-device claims — equal codes, and equal
# bytes.
run_phase() {
  local flow_name="$1" direction="$2"
  local first_role first_test first_udid first_side
  local second_role second_test second_udid second_side
  local gate_event="" code="" receiver="" receiver_udid="" receiving_name=""
  local receiving_pid="" receiving_log="" live_read="none"

  reset_roles
  phase_out="$output/$flow_name-$direction"
  mkdir -p "$phase_out"
  local phase_started=$SECONDS

  # In every flow the role that PUBLISHES is started first, because the second
  # role cannot begin without what it publishes: a Nearby connector needs a
  # resident already in the room, and a joining device needs six digits that do
  # not exist yet.
  case "$flow_name" in
    nearby)
      first_role="nearby-resident"
      first_test="testNearbyAcceptsThePhysicalPeerAndTransfersBothWays"
      second_role="nearby-connector"
      second_test="testNearbyConnectsToThePhysicalPeerAndTransfersBothWays"
      gate_event="READY"
      # The RESIDENT receives, so on `a-to-b` — A sends — the resident is B.
      if [ "$direction" = "a-to-b" ]; then first_side=b; second_side=a
      else first_side=a; second_side=b; fi
      ;;
    pairing-files)
      first_role="pair-file-generator"
      first_test="testPairingCodeFilesAreSentToThePhysicalPeer"
      second_role="pair-file-joiner"
      second_test="testPairingCodeFilesFromThePhysicalPeerAreReceived"
      gate_event="PAIRING-CODE"
      # The GENERATOR sends, so on `a-to-b` the generator is A.
      if [ "$direction" = "a-to-b" ]; then first_side=a; second_side=b
      else first_side=b; second_side=a; fi
      ;;
    pairing-text)
      first_role="pair-text-generator"
      first_test="testPairingCodeTextIsExchangedWithThePhysicalPeer"
      second_role="pair-text-joiner"
      second_test="testPairingCodeTextFromThePhysicalPeerIsExchanged"
      gate_event="PAIRING-CODE"
      if [ "$direction" = "a-to-b" ]; then first_side=a; second_side=b
      else first_side=b; second_side=a; fi
      ;;
  esac

  local first_udid_var="udid_$first_side" second_udid_var="udid_$second_side"
  local first_family_var="family_$first_side" second_family_var="family_$second_side"
  first_udid="${!first_udid_var}"
  second_udid="${!second_udid_var}"

  say ""
  say "== $flow_name, $direction =="
  say "-- $first_role on device $(side_label "$first_side"), $second_role on device $(side_label "$second_side")"

  receiver="$(receiving_side "$flow_name" "$direction")"
  receiving_name="$(receiving_role "$flow_name")"
  # The two rules answer different questions — which DEVICE writes the file,
  # which ROLE holds its completed state while that file is read — and they are
  # separate functions for it. The self-test proves they agree across every
  # phase; this is the same agreement re-made at runtime, because a phase that
  # skipped the byte check or held a role that is not in it would otherwise be a
  # green run.
  if { [ -n "$receiver" ] && [ -z "$receiving_name" ]; } \
     || { [ -z "$receiver" ] && [ -n "$receiving_name" ]; }; then
    fail "harness defect: $flow_name $direction cannot agree whether it receives a file
     (device '$receiver', role '$receiving_name')."
  fi
  if [ -n "$receiver" ]; then
    local receiver_udid_var="udid_$receiver"
    receiver_udid="${!receiver_udid_var}"
    # Which side that role is played on, checked rather than assumed: the role
    # is a function of the flow and the side is a function of the direction, and
    # a phase where they name different devices would read one device's container
    # while the other one held.
    local expected_side="$first_side"
    [ "$receiving_name" = "$second_role" ] && expected_side="$second_side"
    [ "$expected_side" = "$receiver" ] || fail \
      "harness defect: $flow_name $direction expects $receiving_name to receive on device
     $(side_label "$expected_side"), but the file is written on device $(side_label "$receiver")."
    if [ "$keep_received" -eq 0 ]; then
      say "-- device $(side_label "$receiver") will empty Relayium's OWN Received folder inside its own"
      say "   container before it receives. Nothing else on that device is touched."
    else
      say "-- --keep-received: device $(side_label "$receiver") keeps its Received folder, so this phase"
      say "   will fail on a name it already holds if it has run before."
    fi
  fi

  # Two run-unique strings, one per direction, each asserted character for
  # character by the OTHER device. A device somehow talking to an unrelated
  # Relayium on the same public address fails on these rather than passing.
  local first_message="RLY-$run_tag-$flow_name-1"
  local second_message="RLY-$run_tag-$flow_name-2"

  start_role "$first_udid" "$first_role" "$first_test" \
    "${!second_family_var}" "$first_message" "$second_message" "" \
    "$phase_out/$first_role.log"
  local first_pid="${role_pids[0]}"

  say "-- waiting for $first_role to publish $gate_event before starting $second_role"
  local gate_status=0
  code="$(ios_await_event "$channel" "$phase_out/$first_role.log" "$run_tag" \
            "$first_role" "$gate_event" "$first_pid" "$peer_budget")" || gate_status=$?
  case "$gate_status" in
    0) ;;
    1) fail "$first_role exited before it was ready; $second_role was never started,
     so no device was driven against a peer that was not there. Its log and result
     bundle are in $phase_out" ;;
    2) fail "$first_role did not become ready within ${peer_budget}s. Nothing was started
     on the second device. Its log and result bundle are in $phase_out" ;;
  esac

  # Only a pairing flow hands anything forward; a Nearby READY is a gate and not
  # a value. Whatever is handed forward has already been held to the event's own
  # pattern by the channel — six decimal digits is six decimal digits — before it
  # can reach another process.
  local forwarded=""
  [ "$gate_event" = "PAIRING-CODE" ] && forwarded="$code"

  start_role "$second_udid" "$second_role" "$second_test" \
    "${!first_family_var}" "$second_message" "$first_message" "$forwarded" \
    "$phase_out/$second_role.log"

  # ── the LIVE read, before the receiving runner presses anything ────────────
  #
  # The receiving role publishes RECEIVED and then HOLDS: its app is up, on the
  # screen that named the file, and it has not pressed the product's own Done.
  # The bytes are read here, in that window, and the runner is released only
  # afterwards. A read taken only after both processes had exited could not tell
  # bytes that were never written from bytes something removed on the way out.
  if [ -n "$receiving_name" ]; then
    receiving_log="$phase_out/$receiving_name.log"
    receiving_pid="${role_pids[0]}"
    [ "$receiving_name" = "$second_role" ] && receiving_pid="${role_pids[1]}"
    say "-- waiting for $receiving_name to publish RECEIVED and hold, so its container can"
    say "   be read while its app is still in the state the product reached"
    # Bounded by the PHASE's ceiling and not by `--peer-budget`. The two budgets
    # measure different things: `peer_budget` bounds one runner waiting for the
    # other to reach a screen, while this waits for the whole transfer to
    # complete on the far device — a cold install, a launch, a room, a
    # handshake and a batch. Sizing it as a peer wait would make a slow-but-
    # healthy phase skip its live read and quietly fall back to the weaker
    # evidence, which is the failure a budget must never produce. It is safe to
    # be generous because `ios_await_event` returns as soon as the publisher
    # dies, so this is long only while something is genuinely still running.
    local live_status=0
    ios_await_event "$channel" "$receiving_log" "$run_tag" \
      "$receiving_name" RECEIVED "$receiving_pid" "$phase_budget" >/dev/null || live_status=$?
    if [ "$live_status" -eq 0 ]; then
      require_received_bytes "$receiver_udid" "$receiver" live none
      live_read=verified
      release_receiver "$receiver_udid" "$receiving_name"
    else
      # Not fatal HERE. Whatever went wrong is the receiving runner's own
      # failure, and `await_roles` reports it with that runner's log rather than
      # as a missing barrier; the post-exit read below still runs and still
      # refuses. What is lost is only the ability to attribute a missing file.
      say "-- $receiving_name did not publish RECEIVED while it was alive (status $live_status),"
      say "   so no live read was taken. Its own failure is reported below."
    fi
  fi

  # The phase's ceiling is a ceiling on the PHASE, so what is left of it is what
  # the runners get. Passing the whole budget again here would let one phase
  # consume two of them: the wait above is inside this ceiling, not beside it.
  # Floored, because a phase that is already over its budget still has to reap
  # its children rather than skip the barrier entirely.
  local phase_left=$((phase_budget - (SECONDS - phase_started)))
  [ "$phase_left" -ge 60 ] || phase_left=60
  await_roles "$phase_left"

  # Both runners passed everything they can each see. These are the two claims
  # neither of them could make alone.
  require_equal_sas "$phase_out/$first_role.log" "$first_role" \
                    "$phase_out/$second_role.log" "$second_role"

  if [ -n "$receiver" ]; then
    ios_published "$channel" "$receiving_log" "$run_tag" \
      "$receiving_name" RECEIVED >/dev/null \
      || fail "$receiving_name never reported a committed inbound batch"
    # ── and the same read AFTER the shipped exit ─────────────────────────────
    #
    # Not a retry of the live one. This is the product's promise to a person:
    # the file they were told they received is still theirs once they dismiss
    # the receipt. It is taken on every receiving phase whether or not the live
    # read happened, so a run can never report a pass on bytes nobody looked for.
    require_received_bytes "$receiver_udid" "$receiver" after-exit "$live_read"
  fi

  say "-- $flow_name $direction: PASSED"
  reset_roles
}

plan="$(phase_plan "$flow" "$directions")"
[ -n "$plan" ] || fail "no phase matches --flow $flow --directions $directions"
say "-- phases: $plan"

for entry in $plan; do
  run_phase "${entry%%:*}" "${entry##*:}"
done

say ""
say "== every requested phase passed =="
say "-- artifacts: $output"
say "-- proved: real two-device Nearby and pairing-code connections on production"
say "   origin, equal independently-derived verification codes on every one of them,"
say "   a deterministic file whose received BYTES hash to the staged digest both while"
say "   the receiving app held its completion AND after it was dismissed through the"
say "   product's own Done, and run-unique text asserted by exact string in both"
say "   directions."
say "-- NOT proved by this run: a legacy 0.1.0 peer, a second batch on one link, a"
say "   file sent from inside a live Nearby workspace, or pairing-code expiry."
completed=1
say "PASS"
