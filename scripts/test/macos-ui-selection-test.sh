#!/bin/sh
# Tests for scripts/lib/macos-ui-test-selection.sh — which LocalSessionUITests
# methods a `macos-ui-session-acceptance.sh` invocation runs, and therefore
# which pairing counterparts that run may demand a served `link/1` from.
#
# This suite exists for one incident. The launcher starts one `pair-link`
# counterpart per pairing SESSION the suite establishes and, at the end, asks
# EVERY pairing counterpart whether it served a link. Run with
# `-only-testing:RelayiumUITests/LocalSessionUITests/testBothModulesHold…`,
# xcodebuild passed and the first counterpart reported its one `link/1` session
# — and the run then failed against the second counterpart, which belongs to
# the test that selection had not asked for and which nothing had contacted. A
# red run, a real build, and no defect.
#
# The property under test is the mapping itself, which is where both failure
# modes live: demanding a peer that was never in play (the incident), and the
# opposite one — a selection quietly verified against nothing while the run
# still prints the full PASS. So every case asserts BOTH the methods selected
# and the exit status, and the refusal cases assert that a shape the launcher
# cannot map is refused rather than resolved to "everything" or "nothing".
#
# No product, no server, no build: the subject is pure functions over an
# argument list, and the two facts that reach outside it — that the canonical
# method list still names the tests that exist, and that the launcher takes its
# names from here rather than repeating them — are read out of the sources.
#
#   sh scripts/test/macos-ui-selection-test.sh
#
# POSIX sh, like the library under test. Lives next to its subject and runs in
# CI — see .github/workflows/repo-hygiene.yml.
set -u

HERE=$(CDPATH='' cd -P -- "$(dirname -- "$0")" && pwd -P)
ROOT="$HERE/../.."
LIB="$ROOT/scripts/lib/macos-ui-test-selection.sh"
LAUNCHER="$ROOT/scripts/macos-ui-session-acceptance.sh"
SWIFT="$ROOT/apps/mac/RelayiumUITests/LocalSessionUITests.swift"

BOTH=testBothModulesHoldRealConnectionsAcrossNavigationAndCancelDirectOnly
NEARBY_FIRST=testCancellingTheNearbyModuleFirstLeavesTheDirectSessionConnected
CREATOR=testCreatingAPairingCodeSurvivesTheLinkHandoffAndACancelledCode
# The whole suite, in the order the counterparts are started.
ALL="$BOTH $NEARBY_FIRST $CREATOR"

# shellcheck source=../lib/macos-ui-test-selection.sh
. "$LIB"

fail=0
ok() { printf '  ok   %s\n' "$1"; }
bad() {
  printf '  FAIL %s\n' "$1"
  fail=1
}
assert_eq() {
  # assert_eq NAME GOT WANT
  if [ "$2" = "$3" ]; then ok "$1"; else
    bad "$1"
    printf '       want [%s] got [%s]\n' "$3" "$2"
  fi
}

# selected NAME WANT_METHODS WANT_STATUS -- ARGS…
#
# The selection is compared as one space-joined line, so ORDER is asserted too:
# the launcher starts the counterparts in this order and the tests index them by
# it, and a resolver that returned them reversed would point each test at the
# other's peer.
selected() {
  name="$1" want="$2" want_status="$3"
  shift 4
  # Captured WITHOUT a pipe: a `… | tr` would report tr's status, and every
  # refusal case would silently pass as a success. (It did, first run.)
  got="$(macos_ui_selected_methods "$@" 2>/dev/null)" && status=0 || status=$?
  got="$(printf '%s' "$got" | tr '\n' ' ')"
  got="${got% }"
  assert_eq "$name (status)" "$status" "$want_status"
  assert_eq "$name (methods)" "$got" "$want"
}

printf '%s\n' 'macos_ui_selected_methods'

# ── the default run, which must not narrow ───────────────────────────────────
selected 'no arguments runs every method' "$ALL" 0 --
selected 'non-selector arguments alone still run every method' "$ALL" 0 -- \
  -resultBundlePath /tmp/whatever -quiet
selected 'the whole target runs every method' "$ALL" 0 -- \
  -only-testing:RelayiumUITests
selected 'the whole class runs every method' "$ALL" 0 -- \
  -only-testing:RelayiumUITests/LocalSessionUITests
selected 'a trailing slash on the class is still the class' "$ALL" 0 -- \
  -only-testing:RelayiumUITests/LocalSessionUITests/

# ── the incident: one method, one counterpart ────────────────────────────────
selected 'the Direct-first method alone' "$BOTH" 0 -- \
  "-only-testing:RelayiumUITests/LocalSessionUITests/$BOTH"
selected 'the same-network-first method alone' "$NEARBY_FIRST" 0 -- \
  "-only-testing:RelayiumUITests/LocalSessionUITests/$NEARBY_FIRST"
selected 'a method selector among unrelated arguments' "$BOTH" 0 -- \
  -derivedDataPath /tmp/dd "-only-testing:RelayiumUITests/LocalSessionUITests/$BOTH" -quiet
selected 'the separate-argument form of -only-testing' "$BOTH" 0 -- \
  -only-testing "RelayiumUITests/LocalSessionUITests/$BOTH"
selected 'a method written with trailing parentheses' "$NEARBY_FIRST" 0 -- \
  "-only-testing:RelayiumUITests/LocalSessionUITests/$NEARBY_FIRST()"
# The creator method alone: the selection the launcher must map to TWO
# counterparts rather than one.
selected 'the creator method alone' "$CREATOR" 0 -- \
  "-only-testing:RelayiumUITests/LocalSessionUITests/$CREATOR"

# ── several, explicitly, in either order ─────────────────────────────────────
selected 'two methods selected explicitly' "$BOTH $NEARBY_FIRST" 0 -- \
  "-only-testing:RelayiumUITests/LocalSessionUITests/$BOTH" \
  "-only-testing:RelayiumUITests/LocalSessionUITests/$NEARBY_FIRST"
selected 'two methods, reversed, come back in start order' "$BOTH $NEARBY_FIRST" 0 -- \
  "-only-testing:RelayiumUITests/LocalSessionUITests/$NEARBY_FIRST" \
  "-only-testing:RelayiumUITests/LocalSessionUITests/$BOTH"
selected 'the creator method beside a joiner one keeps start order' "$BOTH $CREATOR" 0 -- \
  "-only-testing:RelayiumUITests/LocalSessionUITests/$CREATOR" \
  "-only-testing:RelayiumUITests/LocalSessionUITests/$BOTH"
selected 'the same method twice is one method' "$BOTH" 0 -- \
  "-only-testing:RelayiumUITests/LocalSessionUITests/$BOTH" \
  "-only-testing:RelayiumUITests/LocalSessionUITests/$BOTH"
selected 'a method plus its own class is the class' "$ALL" 0 -- \
  "-only-testing:RelayiumUITests/LocalSessionUITests/$BOTH" \
  -only-testing:RelayiumUITests/LocalSessionUITests

# ── shapes it must refuse rather than guess at ───────────────────────────────
#
# Status 2 and NO selection: refusing is the point, and a refusal that still
# printed a method list would be read by the launcher as an answer.
selected 'an unknown method is refused' '' 2 -- \
  -only-testing:RelayiumUITests/LocalSessionUITests/testSomethingRenamed
selected 'another class in the same target is refused' '' 2 -- \
  -only-testing:RelayiumUITests/AppShellUITests
selected 'another target is refused' '' 2 -- \
  -only-testing:RelayiumKitTests
selected 'a deeper specifier is refused' '' 2 -- \
  "-only-testing:RelayiumUITests/LocalSessionUITests/$BOTH/extra"
selected '-skip-testing is refused' '' 2 -- \
  "-skip-testing:RelayiumUITests/LocalSessionUITests/$BOTH"
selected '-skip-testing is refused even beside a valid selector' '' 2 -- \
  "-only-testing:RelayiumUITests/LocalSessionUITests/$BOTH" \
  "-skip-testing:RelayiumUITests/LocalSessionUITests/$NEARBY_FIRST"
selected '-testPlan is refused' '' 2 -- \
  -testPlan Smoke
selected 'a trailing -only-testing with no specifier is refused' '' 2 -- \
  -derivedDataPath /tmp/dd -only-testing

# A refusal has to say what it refused and what it would accept, because the
# launcher exits on it without building anything.
message="$(macos_ui_selected_methods -only-testing:RelayiumUITests/AppShellUITests 2>&1 >/dev/null)"
case "$message" in
  *AppShellUITests*"-only-testing:RelayiumUITests/LocalSessionUITests/$BOTH"*)
    ok 'the refusal names the rejected selector and the supported ones' ;;
  *)
    bad 'the refusal names the rejected selector and the supported ones'
    printf '       got [%s]\n' "$message" ;;
esac

printf '%s\n' 'macos_ui_pair_index / macos_ui_pair_count / macos_ui_proof'

# The two joiner methods keep the indices they have always read. A change that
# renumbered them would point each existing test at the other's counterpart, and
# nothing in a run would say so — both peers exist and both answer.
assert_eq 'the Direct-first method reads pairPorts[0]' "$(macos_ui_pair_index "$BOTH")" 0
assert_eq 'the same-network-first method reads pairPorts[1]' \
  "$(macos_ui_pair_index "$NEARBY_FIRST")" 1
# The creator method establishes TWO sequential pairing sessions in one app
# lifecycle — `pair-link` serves one room per process — so it owns a RANGE, and
# the launcher must demand a served link from BOTH of its peers. Checking only
# the first would pass a run in which the code minted after a cancel had gone
# out unwatched, which is the defect that method exists to catch.
assert_eq 'the creator method starts at pairPorts[2]' "$(macos_ui_pair_index "$CREATOR")" 2
assert_eq 'the creator method uses two counterparts' "$(macos_ui_pair_count "$CREATOR")" 2
assert_eq 'the creator method verifies both of them' \
  "$(macos_ui_pair_indices "$CREATOR" | tr '\n' ' ')" '2 3 '
assert_eq 'a one-peer method verifies exactly its own' \
  "$(macos_ui_pair_indices "$NEARBY_FIRST" | tr '\n' ' ')" '1 '
assert_eq 'the suite needs four pairing counterparts' "$(macos_ui_pair_total)" 4
assert_eq 'pairPorts[0] belongs to the Direct-first method' \
  "$(macos_ui_method_for_pair_index 0)" "$BOTH"
assert_eq 'pairPorts[2] belongs to the creator method' \
  "$(macos_ui_method_for_pair_index 2)" "$CREATOR"
assert_eq 'pairPorts[3] belongs to the creator method too' \
  "$(macos_ui_method_for_pair_index 3)" "$CREATOR"
for probe in macos_ui_pair_index macos_ui_pair_count macos_ui_pair_indices; do
  if "$probe" testNotAMethod >/dev/null 2>&1; then
    bad "an unknown method has no answer from $probe"
  else
    ok "an unknown method has no answer from $probe"
  fi
done
if macos_ui_method_for_pair_index 99 >/dev/null 2>&1; then
  bad 'an index past the last counterpart belongs to nobody'
else
  ok 'an index past the last counterpart belongs to nobody'
fi

printf '%s\n' 'macos_ui_uses_nearby_peer'

# The other half of the same incident: the launcher's closing checks ask the
# RESIDENT peer whether it served a link, and that question was unconditional
# because every method used to establish a same-network session. A run narrowed
# to the creator method — which touches only the Cross-network module — failed
# against a peer nothing had contacted.
for m in "$BOTH" "$NEARBY_FIRST"; do
  if macos_ui_uses_nearby_peer "$m"; then
    ok "$m uses the resident same-network counterpart"
  else
    bad "$m uses the resident same-network counterpart"
  fi
done
if macos_ui_uses_nearby_peer "$CREATOR"; then
  bad 'the creator method does NOT use the resident same-network counterpart'
else
  ok 'the creator method does NOT use the resident same-network counterpart'
fi
if macos_ui_uses_nearby_peer testNotAMethod; then
  bad 'an unknown method does not claim the resident counterpart'
else
  ok 'an unknown method does not claim the resident counterpart'
fi

# shellcheck disable=SC2086 # deliberate word split: these are method lists
if macos_ui_any_uses_nearby_peer $ALL; then
  ok 'the default run demands the resident counterpart'
else
  bad 'the default run demands the resident counterpart'
fi
if macos_ui_any_uses_nearby_peer "$CREATOR"; then
  bad 'a creator-only run demands nothing of the resident counterpart'
else
  ok 'a creator-only run demands nothing of the resident counterpart'
fi
if macos_ui_any_uses_nearby_peer "$CREATOR" "$BOTH"; then
  ok 'a mixed selection still demands the resident counterpart'
else
  bad 'a mixed selection still demands the resident counterpart'
fi
if macos_ui_any_uses_nearby_peer; then
  bad 'an empty selection demands nothing of the resident counterpart'
else
  ok 'an empty selection demands nothing of the resident counterpart'
fi

printf '%s\n' 'totality over the canonical list'

# Totality: every canonical method has a contiguous index range starting where
# the previous one ended, a phrase for the partial PASS line, and a stated
# answer about the resident counterpart. A method added without any of them
# would be verified against the wrong peer, summarised as an empty string, or
# silently treated as not using a peer it does use.
i=0
for m in $(macos_ui_methods); do
  assert_eq "$m starts at index $i" "$(macos_ui_pair_index "$m")" "$i"
  count="$(macos_ui_pair_count "$m")" || count=''
  if [ -n "$count" ] && [ "$count" -ge 1 ] 2>/dev/null; then
    ok "$m uses $count pairing counterpart(s)"
  else
    bad "$m states how many pairing counterparts it uses"
    count=1
  fi
  if phrase="$(macos_ui_proof "$m")" && [ -n "$phrase" ]; then
    ok "$m names what it proves ($phrase)"
  else
    bad "$m names what it proves"
  fi
  # Yes or no, but never "unknown method": the launcher branches on this, and a
  # method the lookup does not recognise answers 2, which reads as false.
  macos_ui_uses_nearby_peer "$m"
  case "$?" in
    0 | 1) ok "$m states whether it uses the resident counterpart" ;;
    *)     bad "$m states whether it uses the resident counterpart" ;;
  esac
  i=$((i + count))
done
# The ranges and the peer count are one fact: a mismatch would either start a
# peer nothing reads or index past the last one started.
assert_eq 'the ranges cover exactly the counterparts the launcher starts' \
  "$i" "$(macos_ui_pair_total)"

printf '%s\n' 'the list against the sources'

# The names here are the ones XCTest will be asked for, so a renamed test must
# fail HERE rather than as a twenty-minute run that selects a method the runner
# does not have.
for m in $(macos_ui_methods); do
  if grep -q "func $m(" "$SWIFT"; then
    ok "$m exists in LocalSessionUITests.swift"
  else
    bad "$m exists in LocalSessionUITests.swift"
  fi
done
swift_count="$(grep -c '^    func test' "$SWIFT" | tr -d ' ')"
assert_eq 'the class defines exactly the methods this list knows' \
  "$swift_count" "$(macos_ui_methods | wc -l | tr -d ' ')"

# One definition of the method names: a launcher that also spelled them out
# could select a method whose counterpart requirement is decided elsewhere.
if grep -q "$BOTH" "$LAUNCHER" || grep -q "$NEARBY_FIRST" "$LAUNCHER"; then
  bad 'the launcher takes the method names from the library'
else
  ok 'the launcher takes the method names from the library'
fi

printf '%s\n' 'the /api/ice limiter window between default rounds'

# The launcher runs each default method as its own xcodebuild process against ONE
# server, and every process it starts is on 127.0.0.1 — so the whole run spends
# one address's `/api/ice` budget. Measured before this rule existed: the second
# method's counterpart was answered 429, ended `roomUnavailable` and never opened
# its link, against a build with no defect in it.
#
# The rule is sourced rather than re-implemented here. The launcher stops after
# defining it when asked to, so this costs no server, no build and no minute of
# real time — and it is the SAME text the run uses, which a copy would not be.
MACOS_UI_ACCEPTANCE_RULES_ONLY=1
export MACOS_UI_ACCEPTANCE_RULES_ONLY
# shellcheck source=../macos-ui-session-acceptance.sh
if . "$LAUNCHER"; then
  ok 'the launcher defines its sequencing rule without starting a run'
else
  bad 'the launcher defines its sequencing rule without starting a run'
fi
unset MACOS_UI_ACCEPTANCE_RULES_ONLY

# The window is the server's, not a number this script picked. `/api/ice` is
# capped per TRAILING minute (`signal.RateLimiter.Allow` keeps only the hits
# newer than the window), so a launcher waiting less than a minute would still
# be counted against the round before it.
assert_eq 'the wait window is the limiter window' \
  "${ice_limiter_window_seconds:-unset}" '60'
if grep -q 'PerInstanceThreshold(5, div), time.Minute' "$ROOT/server/main.go"; then
  ok 'the server still caps /api/ice at 5 per minute'
else
  bad 'the server still caps /api/ice at 5 per minute'
fi

# The remainder, so time already spent between rounds counts — and never a
# negative sleep, which `sleep` would reject and `set -e` would turn into a
# failed run minutes after the tests themselves passed.
assert_eq 'a round that has just exited waits the whole window' \
  "$(ice_limiter_wait_seconds 60 0)" '60'
assert_eq 'time already spent between rounds counts towards the wait' \
  "$(ice_limiter_wait_seconds 60 10)" '50'
assert_eq 'a window that has exactly passed waits no longer' \
  "$(ice_limiter_wait_seconds 60 60)" '0'
assert_eq 'a window long past never answers a negative sleep' \
  "$(ice_limiter_wait_seconds 60 90)" '0'

# Where the wait is spent is as load-bearing as how long it is. It belongs
# BETWEEN default rounds only: waiting before the first would be a minute
# proving nothing, and a caller's own selectors are one invocation that has
# nothing to wait for.
if grep -q 'previous_round_exited=$' "$LAUNCHER"; then
  ok 'the first default round does not wait'
else
  bad 'the first default round does not wait'
fi
# shellcheck disable=SC2016 # the literal $name IS the pattern: this greps source text
launcher_waits="$(grep -c 'ice_limiter_wait_seconds "\$ice_limiter_window_seconds"' "$LAUNCHER" | tr -d ' ')"
assert_eq 'exactly one place in the launcher spends the wait' "$launcher_waits" '1'
# That one place is inside the default loop, which is the `else` branch of the
# caller-selector test — so a caller's `-only-testing:` run is unchanged.
caller_branch="$(sed -n '/^if \[ "\$#" -gt 0 \]; then$/,/^else$/p' "$LAUNCHER")"
if printf '%s' "$caller_branch" | grep -q 'ice_limiter_wait_seconds'; then
  bad 'a caller-supplied selection still runs unchanged'
else
  ok 'a caller-supplied selection still runs unchanged'
fi

if [ "$fail" -eq 0 ]; then
  printf '\nPASS: the selector mapping answers every supported shape and refuses the rest.\n'
else
  printf '\nFAIL: the selector mapping is wrong above.\n'
fi
exit "$fail"
