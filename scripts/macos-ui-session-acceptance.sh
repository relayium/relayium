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
#   * PROVES the app AS THE CREATOR of a pairing code: it signs in through its
#     own form, mints a code, and keeps its surface through the `link/1` handoff
#     that retires the legacy model rendering that code. Then, in the SAME
#     process, it cancels a code and mints another, and that second code reaches
#     a real `link/1` rather than the legacy fallback a retained pairing room
#     forces — which is what this method measured against the shipped pane.
#   * CHECKS every one of those claims twice: once against what the window
#     draws, and once against the counterpart process on the other end of the
#     wire. A run where the app believes it is connected and no peer is serving
#     a link fails.
#
# The offline suite covers the same requirement deterministically and without a
# server, INCLUDING both modules holding a session at once; what it cannot claim
# is that connections which really exist survive. Both are needed: this one
# needs a network stack, several counterpart processes and a signed build, and
# the offline one runs on every push.
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
# With no arguments every `LocalSessionUITests` method runs as its own sequential
# `xcodebuild` process against one server and one set of counterparts; see the
# block above the launches for why. Arguments are passed through to a single
# invocation unchanged — and are ALSO read here, without being altered, to
# decide which counterparts the run's own closing checks demand and what its
# PASS line is allowed to claim. `lib/macos-ui-test-selection.sh` holds that
# mapping and the reasoning behind it.

# ── the shared-loopback `/api/ice` budget, and the wait it forces ───────────
#
# Every process this script starts — the app under test, the throwaway server
# and every counterpart — runs on `127.0.0.1`, so the whole run spends ONE
# address's budget at an endpoint sized for one real user. `/api/ice` allows
# five requests per trailing minute per IP (`server/main.go`:
# `account.PerInstanceThreshold(5, div)`, and the divisor is 1 here), and `/ws`
# shares a five-DIFFERENT-codes budget with it. One method spends several: the
# same-network room fetches with an empty code, and each pairing room fetches
# once per side.
#
# Measured, and the reason this exists: two methods back to back, and the second
# method's counterpart is answered 429, ends `roomUnavailable` and never opens
# its link — while the app is already establishing, so the app's own screen
# looks right and only the far end says otherwise. A red run against a correct
# build. Each method passes on its own, against a budget nothing has spent.
#
# **The limiter is a TRAILING window, not a bucket that empties on a fixed
# boundary**: `signal.RateLimiter.Allow` keeps only the hits newer than the
# window and counts those. So the rule is not "wait for a reset" — there is none
# — it is "let the previous round's newest hit age out". A full window measured
# from the moment the previous `xcodebuild` EXITED does that with nothing left to
# assume: none of that round's requests can be newer than its own exit.
#
# This neither weakens nor bypasses the limiter. It runs at its real production
# setting for the whole run against a real server; what changes is only that
# this script stops asking one address for more than one address may have.
ice_limiter_window_seconds=60

# How long a default round must wait before it may spend `/api/ice` again.
#
# Pure — window and elapsed in, seconds out — so the rule is testable without a
# server, a build or a minute of real time. The REMAINDER rather than the whole
# window, so anything that already took time between the rounds counts towards
# it; 0, never a negative number, once the window has passed.
ice_limiter_wait_seconds() {
  if [ "$2" -ge "$1" ]; then printf '0\n'; else printf '%s\n' "$(($1 - $2))"; fi
}

# Sourced by `scripts/test/macos-ui-selection-test.sh` to test the rule above.
# Everything BELOW this line has an effect on the machine — a server, a signed
# build, counterpart processes — and nothing above it does, which is what makes
# stopping here safe rather than a partial run.
[ "${MACOS_UI_ACCEPTANCE_RULES_ONLY:-0}" = 1 ] && return 0

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
package_dir="$repo_root/apps/RelayiumKit"
server_dir="$repo_root/server"
project="$repo_root/apps/mac/Relayium.xcodeproj"

# shellcheck source-path=SCRIPTDIR
# shellcheck source=lib/local-acceptance.sh
source "$repo_root/scripts/lib/local-acceptance.sh"
# shellcheck source=lib/macos-ui-test-selection.sh
source "$repo_root/scripts/lib/macos-ui-test-selection.sh"

# Decided FIRST, before a single thing is built or started: an unmappable
# selector is a caller error, and answering it after a server, the counterpart
# peers and a signed build have gone up would charge minutes for a typo. `fail`
# is not available yet either — it diagnoses a run root that does not exist
# until `acceptance_begin`.
if ! selected_methods="$(macos_ui_selected_methods "$@")"; then
  printf 'FAIL: this run cannot state what it would have proved.\n' >&2
  exit 2
fi
selected_count="$(printf '%s\n' "$selected_methods" | wc -l | tr -d ' ')"
method_count="$(macos_ui_methods | wc -l | tr -d ' ')"
# The same set as one space-delimited line, for membership tests: the list is
# newline-separated, and a ` $m ` pattern against it would only ever match the
# first and last entries.
selected_set=" "
for test_method in $selected_methods; do selected_set="$selected_set$test_method "; done

acceptance_begin
acceptance_build "$server_dir" "$package_dir"
acceptance_start_server
# The App-as-creator method signs in through the product's own form, because
# minting a code is account-gated and a fabricated bearer would be a fixture
# contradicting the run. See `acceptance_create_account` for what that exception
# is bounded by.
acceptance_publish_password=1
acceptance_create_account

# ── the counterparts ─────────────────────────────────────────────────────────
#
# The resident one is started BEFORE the app so it is already in the room when
# the roster is first read. Its name carries the run tag: a shared machine may
# have another run resident, and a roster assertion matching on a constant would
# pass against somebody else's peer.
mkdir -p "$run_root/nearby-receive"

peer_name="acceptance-peer-$run_tag"
start_peer nearby-receiver nearby-receiver \
  --name "$peer_name" \
  --receive-root "$run_root/nearby-receive"
nearby_port="$peer_port"

assert_control_api_is_guarded "$nearby_port"

# The pairing halves, one per pairing SESSION the suite establishes. `pair-link`
# starts one run per process and `LinkWorkspaceModel.watchPairingCode` refuses a
# second room while the first is active, so no two of them can share a
# counterpart: the second would ask a process already in a room to serve another,
# and wait out its whole budget for a session that never comes. The
# App-as-creator method establishes two in one app lifecycle and therefore owns
# two; `lib/macos-ui-test-selection.sh` is where that count lives.
#
# They hold the account bearer, which reaches them through the environment and
# never through argv, and `start_peer` clears the slot immediately afterwards so
# no later peer inherits it.
#
# `pair-link` rather than `pair-sender`: the app joins a `link/1` pairing room
# here, which is the wire a current client actually gets, and the legacy role
# would prove the fallback instead.
#
# BOTH are started even when the caller selected one test, and the full list is
# handed to XCTest either way, because the tests reach their own counterpart by
# INDEX. Which of them the closing checks then demand a served link from is a
# separate question, answered by the selection above; the peer that no selected
# test contacts is shut down like the others and never asserted against.
pair_ports=""
pair_total="$(macos_ui_pair_total)"
pair_index=0
while [ "$pair_index" -lt "$pair_total" ]; do
  round=$((pair_index + 1))
  mkdir -p "$run_root/pair-link-$round"
  peer_env=("RELAYIUM_ACCEPTANCE_ACCOUNT_TOKEN=$account_token")
  start_peer "pair-link-$round" pair-link --receive-root "$run_root/pair-link-$round"
  pair_ports="${pair_ports:+$pair_ports,}$peer_port"
  say "-- pairPorts[$pair_index] on $peer_port belongs to $(macos_ui_method_for_pair_index "$pair_index")"
  pair_index=$((pair_index + 1))
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
# The throwaway account, for the method that drives the app as the CREATOR of a
# code. Through the environment for the same reason the control bearer is: argv
# on macOS is readable by every process this user runs.
export TEST_RUNNER_RELAYIUM_ACCEPTANCE_ACCOUNT_EMAIL="$account_email"
export TEST_RUNNER_RELAYIUM_ACCEPTANCE_ACCOUNT_PASSWORD="$account_password"

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
# exactly those arguments, unchanged. What the selection changes is only what
# this run afterwards demands of the counterparts, and what it says it proved.
if [ "$#" -gt 0 ]; then
  say "== driving the caller's selectors against the built macOS app =="
  say "-- that selection runs $selected_count of $method_count LocalSessionUITests method(s):"
  for test_method in $selected_methods; do
    say "   $test_method (pairing counterpart(s) #$(macos_ui_pair_indices "$test_method" | tr '\n' ' '))"
  done
  run_xcodebuild xcodebuild "$@"
else
  round=0
  # Empty until a round has actually exited, so the FIRST round never waits:
  # nothing has spent the budget yet, and a minute of sleep before the first
  # build would be a minute that proves nothing.
  previous_round_exited=
  for test_method in $selected_methods; do
    round=$((round + 1))
    if [ -n "$previous_round_exited" ]; then
      wait_seconds="$(ice_limiter_wait_seconds "$ice_limiter_window_seconds" \
        "$(($(date +%s) - previous_round_exited))")"
      if [ "$wait_seconds" -gt 0 ]; then
        say "-- letting the previous round's /api/ice requests age out (${wait_seconds}s)"
        sleep "$wait_seconds"
      fi
    fi
    say "== driving LocalSessionUITests/$test_method (process $round of $selected_count) =="
    run_xcodebuild "xcodebuild-$round" \
      "-only-testing:RelayiumUITests/LocalSessionUITests/$test_method"
    previous_round_exited="$(date +%s)"
  done
fi

# The test asserted the connections itself, from inside the app. This is the
# launcher's own independent read of the SAME counterparts, so a suite that had
# somehow passed without a peer ever serving a link still fails here.
#
# Each counterpart belonging to a SELECTED test served exactly the session(s)
# that test established. A peer that ends the run having never held one means
# the app's screen drew a connection nobody was on the other end of.
#
# The peer of a test that this invocation did not run is a different statement:
# it was started to keep the index list stable and was never contacted, so
# demanding a link from it would fail a run for doing exactly what the caller
# asked. It is named as unverified rather than quietly counted as proof.
#
# **That applies to the RESIDENT same-network peer too, and it did not used to.**
# The check below was unconditional because every method established a
# same-network session; the App-as-creator method touches only the Cross-network
# module, so a run narrowed to it failed against a peer nothing had contacted —
# a red run, a real build, and no defect, which is precisely the incident
# `lib/macos-ui-test-selection.sh` exists to prevent. Which methods use it is
# answered there, per method, so a new one has to state it.
# shellcheck disable=SC2086 # deliberate word split: the selection is a list
if macos_ui_any_uses_nearby_peer $selected_methods; then
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
else
  say "-- no selected test establishes a same-network session, so the resident"
  say "   counterpart was never contacted and nothing is claimed of it"
fi

# EVERY index of every selected method, not one per method: the App-as-creator
# method establishes two sequential pairing sessions, and a run that checked only
# its first peer would pass while the code minted after a cancel had silently
# fallen back to the legacy wire — which is the defect that method exists to
# catch.
required_pair_indices=""
required_pair_count=0
for test_method in $selected_methods; do
  method_indices="$(macos_ui_pair_indices "$test_method")" \
    || fail "the selection named a method with no pairing counterpart: $test_method"
  for method_index in $method_indices; do
    required_pair_indices="$required_pair_indices $method_index"
    required_pair_count=$((required_pair_count + 1))
  done
done

pair_index=0
verified_pairs=0
for pair_port in ${pair_ports//,/ }; do
  case " $required_pair_indices " in
    *" $pair_index "*) ;;
    *)
      say "-- the pairing counterpart on $pair_port belongs to a test this run did"
      say "   not execute, so it was never contacted and nothing is claimed of it:"
      say "   $(macos_ui_method_for_pair_index "$pair_index")"
      control "$pair_port" POST /shutdown >/dev/null || true
      pair_index=$((pair_index + 1))
      continue
      ;;
  esac

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
  verified_pairs=$((verified_pairs + 1))
  pair_index=$((pair_index + 1))
done

# One verified counterpart per pairing SESSION the selected tests establish,
# counted rather than assumed: a selection this launcher mapped but whose peer it
# never actually reached would otherwise reach the PASS line having checked fewer
# peers than it names.
[ "$verified_pairs" -eq "$required_pair_count" ] \
  || fail "checked $verified_pairs pairing counterpart(s) for the $required_pair_count the selected test(s) use"

control "$nearby_port" POST /shutdown >/dev/null || true

assert_run_was_local

completed=1
say ""
# The claim is bounded by what actually ran. Both cancel orders and all three
# counterparts is the DEFAULT run's result; a selected subset proved the orders
# it executed and nothing about the one it skipped, and says so — a PASS line
# that reads the same either way is how a narrowed run gets quoted as a full one.
if [ "$selected_count" -eq "$method_count" ]; then
  say "PASS: the built macOS app held a real same-network link AND a real pairing"
  say "      link/1 at the same time, kept both across five round trips in each"
  say "      direction, and cancelled them one at a time in both orders without"
  say "      either teardown reaching the other module; and, as the CREATOR of a"
  say "      code, carried its own pairing code through the link/1 handoff and then"
  say "      reached a second real link after cancelling one — checked on screen"
  say "      and against every counterpart process."
else
  say "PASS (PARTIAL — $selected_count of $method_count LocalSessionUITests methods):"
  # The narrowed line claims only what the selection actually establishes. It
  # used to describe the two-simultaneous-links requirement whatever ran, which
  # a creator-only selection never touches — and a PASS line that reads the same
  # either way is how a narrowed run gets quoted as a full one.
  # shellcheck disable=SC2086 # deliberate word split: the selection is a list
  if macos_ui_any_uses_nearby_peer $selected_methods; then
    say "      the built macOS app held a real same-network link AND a real pairing"
    say "      link/1 at the same time and kept both across five round trips in each"
    say "      direction, checked on screen and against the same-network counterpart"
    say "      and the $verified_pairs pairing counterpart(s) the selected test(s) used."
  else
    say "      checked on screen and against the $verified_pairs pairing counterpart(s)"
    say "      the selected test(s) used. No same-network session was established,"
    say "      so nothing is claimed about the resident counterpart."
  fi
  say "      Proved:"
  for test_method in $selected_methods; do
    say "        - $(macos_ui_proof "$test_method") ($test_method)"
  done
  for test_method in $(macos_ui_methods); do
    case "$selected_set" in
      *" $test_method "*) ;;
      *) say "      NOT run, so NOT proved: $(macos_ui_proof "$test_method")" ;;
    esac
  done
fi
