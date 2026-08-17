#!/bin/sh
# Tests for scripts/lib/macos-ui-test-selection.sh — which LocalSessionUITests
# methods a `macos-ui-session-acceptance.sh` invocation runs, and therefore
# which pairing counterparts that run may demand a served `link/1` from.
#
# This suite exists for one incident. The launcher starts one `pair-link`
# counterpart per test and, at the end, asks EVERY pairing counterpart whether
# it served a link. Run with
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
selected 'no arguments runs both methods' "$BOTH $NEARBY_FIRST" 0 --
selected 'non-selector arguments alone still run both' "$BOTH $NEARBY_FIRST" 0 -- \
  -resultBundlePath /tmp/whatever -quiet
selected 'the whole target runs both' "$BOTH $NEARBY_FIRST" 0 -- \
  -only-testing:RelayiumUITests
selected 'the whole class runs both' "$BOTH $NEARBY_FIRST" 0 -- \
  -only-testing:RelayiumUITests/LocalSessionUITests
selected 'a trailing slash on the class is still the class' "$BOTH $NEARBY_FIRST" 0 -- \
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

# ── both, explicitly, in either order ────────────────────────────────────────
selected 'both methods selected explicitly' "$BOTH $NEARBY_FIRST" 0 -- \
  "-only-testing:RelayiumUITests/LocalSessionUITests/$BOTH" \
  "-only-testing:RelayiumUITests/LocalSessionUITests/$NEARBY_FIRST"
selected 'both methods, reversed, come back in start order' "$BOTH $NEARBY_FIRST" 0 -- \
  "-only-testing:RelayiumUITests/LocalSessionUITests/$NEARBY_FIRST" \
  "-only-testing:RelayiumUITests/LocalSessionUITests/$BOTH"
selected 'the same method twice is one method' "$BOTH" 0 -- \
  "-only-testing:RelayiumUITests/LocalSessionUITests/$BOTH" \
  "-only-testing:RelayiumUITests/LocalSessionUITests/$BOTH"
selected 'a method plus its own class is the class' "$BOTH $NEARBY_FIRST" 0 -- \
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

printf '%s\n' 'macos_ui_pair_index / macos_ui_cancel_order'

assert_eq 'the Direct-first method reads pairPorts[0]' "$(macos_ui_pair_index "$BOTH")" 0
assert_eq 'the same-network-first method reads pairPorts[1]' \
  "$(macos_ui_pair_index "$NEARBY_FIRST")" 1
if macos_ui_pair_index testNotAMethod >/dev/null 2>&1; then
  bad 'an unknown method has no index'
else
  ok 'an unknown method has no index'
fi

# Totality: every canonical method has an index equal to its position and a
# cancel-order phrase. A method added to the list without one would reach the
# partial PASS line and be summarised as an empty string.
i=0
for m in $(macos_ui_methods); do
  assert_eq "$m has index $i" "$(macos_ui_pair_index "$m")" "$i"
  if phrase="$(macos_ui_cancel_order "$m")" && [ -n "$phrase" ]; then
    ok "$m names the cancel order it proves ($phrase)"
  else
    bad "$m names the cancel order it proves"
  fi
  i=$((i + 1))
done

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

if [ "$fail" -eq 0 ]; then
  printf '\nPASS: the selector mapping answers every supported shape and refuses the rest.\n'
else
  printf '\nFAIL: the selector mapping is wrong above.\n'
fi
exit "$fail"
