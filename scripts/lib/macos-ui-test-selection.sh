#!/bin/sh
# Which `LocalSessionUITests` methods an invocation of
# `macos-ui-session-acceptance.sh` will actually run — and therefore which
# pairing counterparts its final independent checks may demand.
#
# ── why this is a separate decision at all ───────────────────────────────────
#
# The launcher starts a pairing counterpart PER PAIRING SESSION a test
# establishes, because `pair-link` serves one room per process and
# `watchPairingCode` refuses a second room while the first is active. Each test
# reaches its own by index — `pairPorts[0]` for the Direct-first cancel order,
# `pairPorts[1]` for the same-network-first one, and `pairPorts[2..3]` for the
# App-as-creator method's two sequential sessions.
#
# The launcher then re-reads every counterpart itself, so a suite that somehow
# passed while no peer was ever on the other end of the wire still fails. That
# check was written for the default run, where both tests execute, and it asked
# BOTH pairing peers whether they had served a link no matter which tests ran. A
# caller that selected one method got a run where xcodebuild passed and the
# launcher then failed against the counterpart that method never contacted —
# a red run reporting a fault that did not exist.
#
# The fix is not to drop the check. It is to know, before anything is built,
# exactly which methods the invocation runs, and to demand a served `link/1`
# from exactly their counterparts — every one of them, with the same real
# control-API health, session and legacy-wire assertions as before.
#
# ── why the full port list is still passed to XCTest ─────────────────────────
#
# `RELAYIUM_ACCEPTANCE_PAIR_PORTS` stays the COMPLETE list regardless of
# selection, because the tests index into it. Trimming it to the selected
# method's peer would move `pairPorts[1]` onto the peer `pairPorts[0]` belongs
# to. This file decides what is VERIFIED, never what is handed to the runner.
#
# ── why an unmappable selector is a failure ──────────────────────────────────
#
# The alternative to refusing is verifying nothing and printing PASS, which is
# the one outcome this harness exists to make impossible. A shape it cannot map
# is reported, with the shapes it can, and the run stops before it builds.
#
# Pure functions over argument lists: no product, no network, no state. POSIX
# sh so `scripts/test/macos-ui-selection-test.sh` can drive it directly.

# ── why a method may now need MORE THAN ONE counterpart ──────────────────────
#
# `pair-link` serves one room per process, so a test that establishes two
# SEQUENTIAL pairing sessions in one app lifecycle needs two of them. The
# App-as-creator method does exactly that: it mints a code, hands it to a peer
# and proves the `link/1` handoff; then cancels a code and mints another, and
# proves that second code reaches a REAL link rather than falling back. A
# creator-side cancel that left its room watched is precisely what would make
# the second half fail, so the two halves cannot share a peer.
#
# So a method's counterparts are a CONTIGUOUS RANGE, `macos_ui_pair_index` is
# its START and `macos_ui_pair_count` is its width. The two existing methods
# keep index 0 and 1 because they are still one peer each and stay first in the
# list — their `pairPorts[0]` / `pairPorts[1]` reads are unchanged.

# The methods, in the order their pairing counterparts are started. This list is
# the single definition of both — the launcher builds its default rounds from it
# rather than repeating the names, and the self-test asserts it against the
# Swift source.
macos_ui_methods() {
  printf '%s\n' \
    testBothModulesHoldRealConnectionsAcrossNavigationAndCancelDirectOnly \
    testCancellingTheNearbyModuleFirstLeavesTheDirectSessionConnected \
    testCreatingAPairingCodeSurvivesTheLinkHandoffAndACancelledCode
}

# How many pairing counterparts a method uses. Unknown method → non-zero and
# nothing printed.
macos_ui_pair_count() {
  case "$1" in
    testBothModulesHoldRealConnectionsAcrossNavigationAndCancelDirectOnly) printf '1\n' ;;
    testCancellingTheNearbyModuleFirstLeavesTheDirectSessionConnected) printf '1\n' ;;
    # Two sequential creator sessions in one app lifecycle: the handoff, then
    # the code minted after a cancel.
    testCreatingAPairingCodeSurvivesTheLinkHandoffAndACancelledCode) printf '2\n' ;;
    *) return 1 ;;
  esac
}

# The 0-based START index of a method's counterparts: its first `pairPorts`
# index and its first peer's start order. Unknown method → non-zero and nothing
# printed, which is also how the selector resolver tells a real method from a
# typo.
macos_ui_pair_index() {
  _mus_i=0
  for _mus_m in $(macos_ui_methods); do
    if [ "$_mus_m" = "$1" ]; then
      printf '%s\n' "$_mus_i"
      return 0
    fi
    _mus_i=$((_mus_i + $(macos_ui_pair_count "$_mus_m")))
  done
  return 1
}

# Every `pairPorts` index a method uses, one per line. This is what the launcher
# demands a served `link/1` from, so a method whose second peer was never
# contacted fails the run rather than being quietly counted as proof.
macos_ui_pair_indices() {
  _mus_start="$(macos_ui_pair_index "$1")" || return 1
  _mus_count="$(macos_ui_pair_count "$1")" || return 1
  _mus_n=0
  while [ "$_mus_n" -lt "$_mus_count" ]; do
    printf '%s\n' "$((_mus_start + _mus_n))"
    _mus_n=$((_mus_n + 1))
  done
}

# How many pairing counterparts the whole suite needs. The launcher starts
# exactly this many regardless of selection, because the tests index into the
# full list.
macos_ui_pair_total() {
  _mus_total=0
  for _mus_m in $(macos_ui_methods); do
    _mus_total=$((_mus_total + $(macos_ui_pair_count "$_mus_m")))
  done
  printf '%s\n' "$_mus_total"
}

# The method that owns a given `pairPorts` index, for the launcher's own start
# and skip messages.
macos_ui_method_for_pair_index() {
  _mus_i=0
  for _mus_m in $(macos_ui_methods); do
    _mus_next=$((_mus_i + $(macos_ui_pair_count "$_mus_m")))
    if [ "$1" -ge "$_mus_i" ] && [ "$1" -lt "$_mus_next" ]; then
      printf '%s\n' "$_mus_m"
      return 0
    fi
    _mus_i="$_mus_next"
  done
  return 1
}

# Whether a method uses the RESIDENT same-network counterpart.
#
# The launcher's closing checks ask that peer whether it served a link, and that
# question was unconditional because every method here used to establish a
# same-network session. The App-as-creator method does not touch the Nearby
# module at all, so a run narrowed to it would fail against a peer nothing had
# contacted — the exact incident this file was written for, in the other
# direction. Answered per method rather than inferred, so a method added without
# stating it fails the self-test rather than a twenty-minute run.
#
# Unknown method → non-zero, like every other lookup here.
macos_ui_uses_nearby_peer() {
  case "$1" in
    testBothModulesHoldRealConnectionsAcrossNavigationAndCancelDirectOnly) return 0 ;;
    testCancellingTheNearbyModuleFirstLeavesTheDirectSessionConnected) return 0 ;;
    testCreatingAPairingCodeSurvivesTheLinkHandoffAndACancelledCode) return 1 ;;
    *) return 2 ;;
  esac
}

# Whether ANY selected method uses the resident same-network counterpart.
# Arguments are the selected method names.
macos_ui_any_uses_nearby_peer() {
  for _mus_m in "$@"; do
    if macos_ui_uses_nearby_peer "$_mus_m"; then
      return 0
    fi
  done
  return 1
}

# What a method proves, for the run's own PASS line. Total over
# `macos_ui_methods` by construction and by self-test: a method with no phrase
# would otherwise be summarised as nothing at all.
macos_ui_proof() {
  case "$1" in
    testBothModulesHoldRealConnectionsAcrossNavigationAndCancelDirectOnly)
      printf '%s\n' 'cancel order: Direct first'
      ;;
    testCancellingTheNearbyModuleFirstLeavesTheDirectSessionConnected)
      printf '%s\n' 'cancel order: same-network first'
      ;;
    testCreatingAPairingCodeSurvivesTheLinkHandoffAndACancelledCode)
      printf '%s\n' 'App as creator: the link/1 handoff, then a cancelled code and a new real link'
      ;;
    *)
      return 1
      ;;
  esac
}

_macos_ui_refuse() {
  {
    printf 'this launcher cannot tell which pairing counterparts %s requires.\n' "$1"
    printf 'It verifies every counterpart the selected tests use, so a shape it\n'
    printf 'cannot map would mean either a false failure against an idle peer or\n'
    printf 'a PASS that checked nothing. Supported selectors:\n'
    printf '  (none)  — the whole suite: every method and every counterpart\n'
    printf '  -only-testing:RelayiumUITests\n'
    printf '  -only-testing:RelayiumUITests/LocalSessionUITests\n'
    for _mus_m in $(macos_ui_methods); do
      printf '  -only-testing:RelayiumUITests/LocalSessionUITests/%s\n' "$_mus_m"
    done
    # `%s` rather than a bare format string: these lines begin with a dash, and
    # `printf '-testPlan …'` is undefined behaviour in POSIX sh.
    printf '%s\n' 'Several -only-testing arguments may be combined; -skip-testing'
    printf '%s\n' 'and -testPlan are refused because either can change the method'
    printf '%s\n' 'set in a way this list cannot see.'
  } >&2
}

# macos_ui_selected_methods <the caller's xcodebuild arguments…>
#
# Prints the selected methods, one per line, in the canonical order above and
# deduplicated. Returns 2 and explains itself on a shape it cannot map.
#
# No `-only-testing` argument at all means the whole suite runs, which includes
# both methods — the default path's requirement is unchanged and unweakened.
macos_ui_selected_methods() {
  _mus_specs=''
  _mus_expect=0

  for _mus_arg in "$@"; do
    if [ "$_mus_expect" -eq 1 ]; then
      _mus_specs="$_mus_specs$_mus_arg
"
      _mus_expect=0
      continue
    fi
    case "$_mus_arg" in
      # xcodebuild accepts the specifier attached or as the next argument.
      -only-testing)
        _mus_expect=1
        ;;
      -only-testing:*)
        _mus_specs="$_mus_specs${_mus_arg#-only-testing:}
"
        ;;
      -skip-testing | -skip-testing:* | -testPlan | -testPlan:*)
        _macos_ui_refuse "$_mus_arg"
        return 2
        ;;
      *) ;;
    esac
  done

  if [ "$_mus_expect" -eq 1 ]; then
    _macos_ui_refuse "a trailing -only-testing with no specifier"
    return 2
  fi

  if [ -z "$_mus_specs" ]; then
    macos_ui_methods
    return 0
  fi

  _mus_wanted=''
  _mus_oldifs="$IFS"
  IFS='
'
  # shellcheck disable=SC2086 # deliberate split on the newline-separated specs
  set -- $_mus_specs
  IFS="$_mus_oldifs"

  for _mus_spec in "$@"; do
    # Xcode writes a method both ways depending on where it was copied from.
    _mus_spec="${_mus_spec%'()'}"
    _mus_spec="${_mus_spec%/}"
    case "$_mus_spec" in
      RelayiumUITests | RelayiumUITests/LocalSessionUITests)
        _mus_wanted="$_mus_wanted $(macos_ui_methods | tr '\n' ' ')"
        ;;
      RelayiumUITests/LocalSessionUITests/*)
        _mus_method="${_mus_spec##*/}"
        if macos_ui_pair_index "$_mus_method" >/dev/null; then
          _mus_wanted="$_mus_wanted $_mus_method"
        else
          _macos_ui_refuse "$_mus_spec"
          return 2
        fi
        ;;
      *)
        _macos_ui_refuse "$_mus_spec"
        return 2
        ;;
    esac
  done

  for _mus_m in $(macos_ui_methods); do
    case " $_mus_wanted " in
      *" $_mus_m "*) printf '%s\n' "$_mus_m" ;;
    esac
  done
}
