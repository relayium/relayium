#!/bin/bash
# **The built macOS app, driven through its own UI, holding a real Nearby
# connection and a real Direct connection at the same time.**
#
# What this proves that the offline `RelayiumUITests/AppShellUITests` cannot:
#
#   * PROVES TWO GENUINELY ESTABLISHED `link/1` sessions in ONE running app at
#     the same time: a same-network one to a resident counterpart, reached from
#     the roster the user reads and the Connect they click, and a cross-network
#     one reached by typing a six-digit code another native process minted.
#   * PROVES the owner's requirement against both of them: each survives
#     navigating to the other destination and is still connected on return, five
#     round trips over.
#   * PROVES each module's Cancel ends only that module, in BOTH orders —
#     Direct first in one test, Nearby first in the other. A teardown that
#     reached across modules passes one order and fails the other.
#   * CHECKS every one of those claims twice: once against what the window
#     draws, and once against the counterpart process on the other end of the
#     wire. A run where the app believes it is connected and no peer is serving
#     a link fails.
#
# The offline suite covers the same requirement deterministically and without a
# server, INCLUDING both modules holding a session at once; what it cannot claim
# is that connections which really exist survive. Both are needed: this one
# needs a network stack, three counterpart processes and a signed build, and the
# offline one runs on every push.
#
# ── why the second real session was not here before ──────────────────────────
#
# An earlier round recorded that the app joining a native-minted pairing code
# "does not currently establish — both native ends reach `watching`". The
# measurement was real; the cause was this harness. Every `--relayium-ui-testing`
# launch, including this one, was handed `UITestMode`'s offline transfer models:
# an ICE client that sleeps for five minutes and a pairing socket factory that
# is a `preconditionFailure`. `watchPairingCode` reads ICE before it opens the
# room, so the app sat in `.watching` and never opened a socket for the peer to
# find. `UITestMode.usesOfflineTransfer` now scopes those fixtures to launches
# that did NOT resolve a loopback origin. No protocol code changed.
#
# ── the seam, and why the app can be pointed at this server at all ───────────
#
# `--relayium-transfer-origin` is `#if DEBUG` and admits loopback origins only.
# `UITestMode.allowsResidency` is `isActive && AppEnvironment.isLoopbackTransferOrigin`,
# which is what lets an acceptance launch join a code-less room at all: the
# public hub keys that room by observed public address, so a resident acceptance
# build would share a roster with strangers, and a loopback origin removes that
# reason rather than tolerating it.
#
# ── signing ──────────────────────────────────────────────────────────────────
#
# macOS UI automation needs a signed app: an ad-hoc or unsigned build cannot
# load the automation runner and `xcodebuild` reports "Test crashed with signal
# kill before establishing connection", which reads like a product crash and is
# not one. So this script does NOT pass `CODE_SIGNING_ALLOWED=NO`, and it needs
# a Developer ID identity in the keychain — the same one the signed CI job
# imports.
#
# The isolation rules — ephemeral ports, one per-run root, tokens in the
# environment, PID-exact cleanup, no release check, loopback-only STUN — live in
# `lib/local-acceptance.sh` and are shared verbatim with the other runs.
#
# ── usage ────────────────────────────────────────────────────────────────────
#
#   scripts/macos-ui-session-acceptance.sh [-only-testing:...]
#
# With no arguments the two `LocalSessionUITests` methods run as TWO sequential
# `xcodebuild` processes against one server and one set of counterparts; see the
# block above the launches for why. Arguments are passed through to a single
# invocation unchanged.

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
package_dir="$repo_root/apps/RelayiumKit"
server_dir="$repo_root/server"
project="$repo_root/apps/mac/Relayium.xcodeproj"

# shellcheck source-path=SCRIPTDIR
# shellcheck source=lib/local-acceptance.sh
source "$repo_root/scripts/lib/local-acceptance.sh"

acceptance_begin
acceptance_build "$server_dir" "$package_dir"
acceptance_start_server
acceptance_create_account

# ── the two counterparts ─────────────────────────────────────────────────────
#
# The resident one is started BEFORE the app so it is already in the room when
# the roster is first read. Its name carries the run tag: a shared machine may
# have another run resident, and a roster assertion matching on a constant would
# pass against somebody else's peer.
mkdir -p "$run_root/nearby-receive" "$run_root/pair-link-1" "$run_root/pair-link-2"

peer_name="acceptance-peer-$run_tag"
start_peer nearby-receiver nearby-receiver \
  --name "$peer_name" \
  --receive-root "$run_root/nearby-receive"
nearby_port="$peer_port"

assert_control_api_is_guarded "$nearby_port"

# The pairing halves, and there are TWO of them on purpose. `pair-link` starts
# one run per process and `LinkWorkspaceModel.watchPairingCode` refuses a second
# room while the first is active, so the two cancel-order tests cannot share a
# counterpart: the second would ask a process that is already in a room to mint
# a code, and wait out its whole budget for one that never comes.
#
# They hold the account bearer, which reaches them through the environment and
# never through argv, and `start_peer` clears the slot immediately afterwards so
# no later peer inherits it.
#
# `pair-link` rather than `pair-sender`: the app joins a `link/1` pairing room
# here, which is the wire a current client actually gets, and the legacy role
# would prove the fallback instead.
pair_ports=""
for round in 1 2; do
  peer_env=("RELAYIUM_ACCEPTANCE_ACCOUNT_TOKEN=$account_token")
  start_peer "pair-link-$round" pair-link --receive-root "$run_root/pair-link-$round"
  pair_ports="${pair_ports:+$pair_ports,}$peer_port"
done

# Residency is started here rather than by the test: it is the state the app
# must find already true, and a room joined from inside the test would race the
# first roster read it is there to assert. The pairing code is NOT minted yet —
# a code is short-lived and single-use, so the test asks for one at the moment
# it is about to type it.
control "$nearby_port" POST /start >/dev/null
say "-- $peer_name is resident in the code-less room on $origin"

maybe_fault after-macos-peers

# ── the built app ────────────────────────────────────────────────────────────
#
# `xcodebuild` passes environment variables prefixed `TEST_RUNNER_` through to
# the test runner with the prefix stripped. The control bearer travels that way
# for the same reason it never reaches a peer's argv: argv on macOS is readable
# by every process this user runs.
export TEST_RUNNER_RELAYIUM_ACCEPTANCE_ORIGIN="$origin"
export TEST_RUNNER_RELAYIUM_ACCEPTANCE_CONTROL_TOKEN="$control_token"
export TEST_RUNNER_RELAYIUM_ACCEPTANCE_NEARBY_PORT="$nearby_port"
export TEST_RUNNER_RELAYIUM_ACCEPTANCE_NEARBY_NAME="$peer_name"
export TEST_RUNNER_RELAYIUM_ACCEPTANCE_PAIR_PORTS="$pair_ports"

derived_data="${RELAYIUM_ACCEPTANCE_DERIVED_DATA:-$run_root/dd-mac}"

# One `xcodebuild test` process, owned by this run.
#
# Backgrounded and waited on, never foregrounded: bash does not service a
# trapped INT/TERM while waiting on a FOREGROUND child, and `xcodebuild test` is
# minutes long — so a foreground call would leave the server and both peers
# running for the whole of that window after a caller had asked the run to stop.
# The PID is REGISTERED first, so cleanup terminates it by exact PID like every
# other child.
#
# Called from the TOP-LEVEL shell and never in a command substitution, for the
# same reason `start_peer` is: a subshell would append the PID to a copy of the
# registry that dies with it, and cleanup would have nothing to kill.
#
# A failure is terminal and reported at the point it happens — the log named,
# its tail printed, and no further invocation started — so a second process
# never runs against the wreckage of the first, and the run cannot report which
# test failed by process of elimination.
run_xcodebuild() {
  local label="$1"
  shift
  local log="$run_root/$label.log" status=0 pid

  xcodebuild -project "$project" -scheme Relayium \
    -destination 'platform=macOS' \
    -derivedDataPath "$derived_data" \
    "$@" \
    test >"$log" 2>&1 &
  pid=$!
  register_child "$label" "$pid"

  wait "$pid" || status=$?
  if [ "$status" -ne 0 ]; then
    say "-- $label failed ($status); its last 80 lines follow — full log: $log"
    sed 's/^/   /' <(tail -80 "$log") >&2 || true
    fail "the built-App session paths did not pass ($label)"
  fi
  say "-- $label passed"
}

# ── one xcodebuild process per test ──────────────────────────────────────────
#
# The default path runs the two `LocalSessionUITests` methods as TWO SEQUENTIAL
# xcodebuild invocations rather than one. Measured with both in a single
# invocation: the first test passes, and then `RelayiumUITest-Runner` fails
# during the SECOND app lifecycle with `RBSAssertionErrorDomain` — an
# invalidation time in the past — and the invocation bails out before the second
# test's assertions run. Each test on its own establishes both sessions and
# passes, so this is the runner's process-assertion lifecycle being reused
# within one invocation, not a product fault; a fresh process per app lifecycle
# removes the overlap.
#
# Both invocations share the derived data, the server, the account and all three
# counterpart processes: the resident same-network peer stays in the room across
# the pair, which is what makes the second test's first roster read the same
# already-true state the first test's was. `RELAYIUM_ACCEPTANCE_PAIR_PORTS`
# stays the FULL list for both, because the tests index it — `pairPorts[0]` and
# `pairPorts[1]` — to reach the counterpart that is theirs. Trimming it per
# invocation would silently point the second test at the peer the first test has
# already used, which `watchPairingCode` would refuse a second room for.
#
# The order below is the order XCTest itself would run them in, so the indices
# keep matching the peers started for them.
#
# A caller that supplied its own selectors gets exactly ONE invocation with
# exactly those arguments, unchanged.
if [ "$#" -gt 0 ]; then
  say "== driving the caller's selectors against the built macOS app =="
  run_xcodebuild xcodebuild "$@"
else
  round=0
  for test_method in \
    testBothModulesHoldRealConnectionsAcrossNavigationAndCancelDirectOnly \
    testCancellingTheNearbyModuleFirstLeavesTheDirectSessionConnected; do
    round=$((round + 1))
    say "== driving LocalSessionUITests/$test_method (process $round of 2) =="
    run_xcodebuild "xcodebuild-$round" \
      "-only-testing:RelayiumUITests/LocalSessionUITests/$test_method"
  done
fi

# The test asserted the connections itself, from inside the app. This is the
# launcher's own independent read of the SAME counterparts, so a suite that had
# somehow passed without a peer ever serving a link still fails here.
#
# The same-network counterpart served one link per test, and each pairing
# counterpart served exactly the one its test established — a pairing peer that
# ends the run having never held a session means the app's Direct screen drew a
# connection nobody was on the other end of.
observed="$(control "$nearby_port" GET /observed)" \
  || fail "the same-network counterpart stopped answering its control API"
python3 - "$observed" <<'PY' || fail "the same-network counterpart served no link at all"
import json, sys

facts = json.loads(sys.argv[1])
if not facts.get("epoch"):
    print("  - the counterpart served no link, so the app's UI reported a "
          "connection that never reached this process", file=sys.stderr)
    sys.exit(1)
print("-- the same-network counterpart served %d link(s)" % facts["epoch"], file=sys.stderr)
PY

for pair_port in ${pair_ports//,/ }; do
  observed="$(control "$pair_port" GET /observed)" \
    || fail "the pairing counterpart on $pair_port stopped answering its control API"
  python3 - "$observed" "$pair_port" <<'PY' \
    || fail "a pairing counterpart never held a link/1 session"
import json, sys

facts = json.loads(sys.argv[1])
# `epoch` counts the links this process has SERVED, so it survives the session
# being cancelled by the test — which every one of them is, by design.
if not facts.get("epoch"):
    print("  - the pairing counterpart on %s served no link, so the app's Direct "
          "screen drew a session nobody was on the other end of" % sys.argv[2],
          file=sys.stderr)
    sys.exit(1)
if facts.get("legacyFallback"):
    print("  - the pairing counterpart on %s fell back to the LEGACY wire: %r"
          % (sys.argv[2], facts["legacyFallback"]), file=sys.stderr)
    sys.exit(1)
print("-- the pairing counterpart on %s served %d link/1 session(s)"
      % (sys.argv[2], facts["epoch"]), file=sys.stderr)
PY
  control "$pair_port" POST /shutdown >/dev/null || true
done

control "$nearby_port" POST /shutdown >/dev/null || true

assert_run_was_local

completed=1
say ""
say "PASS: the built macOS app held a real same-network link AND a real pairing"
say "      link/1 at the same time, kept both across five round trips in each"
say "      direction, and cancelled them one at a time in both orders without"
say "      either teardown reaching the other module — checked on screen and"
say "      against all three counterpart processes."
