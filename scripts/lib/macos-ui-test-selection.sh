#!/bin/sh
# Which `LocalSessionUITests` methods an invocation of
# `macos-ui-session-acceptance.sh` will actually run — and therefore which
# pairing counterparts its final independent checks may demand.
#
# ── why this is a separate decision at all ───────────────────────────────────
#
# The launcher starts ONE pairing counterpart PER TEST, because `pair-link`
# serves one room per process and `watchPairingCode` refuses a second room while
# the first is active. Each test reaches its own by index — `pairPorts[0]` for
# the Direct-first cancel order, `pairPorts[1]` for the same-network-first one.
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

# The methods, in the order their pairing counterparts are started. Position IS
# the `pairPorts` index the method reads, so this list is the single definition
# of both — the launcher builds its default rounds from it rather than repeating
# the names, and the self-test asserts it against the Swift source.
macos_ui_methods() {
  printf '%s\n' \
    testBothModulesHoldRealConnectionsAcrossNavigationAndCancelDirectOnly \
    testCancellingTheNearbyModuleFirstLeavesTheDirectSessionConnected
}

# The 0-based position of a method: its `pairPorts` index and its peer's start
# order. Unknown method → non-zero and nothing printed, which is also how the
# selector resolver tells a real method from a typo.
macos_ui_pair_index() {
  _mus_i=0
  for _mus_m in $(macos_ui_methods); do
    if [ "$_mus_m" = "$1" ]; then
      printf '%s\n' "$_mus_i"
      return 0
    fi
    _mus_i=$((_mus_i + 1))
  done
  return 1
}

# The cancel order a method proves, for the run's own PASS line. Total over
# `macos_ui_methods` by construction and by self-test: a method with no phrase
# would otherwise be summarised as nothing at all.
macos_ui_cancel_order() {
  case "$1" in
    testBothModulesHoldRealConnectionsAcrossNavigationAndCancelDirectOnly)
      printf '%s\n' 'Direct first'
      ;;
    testCancellingTheNearbyModuleFirstLeavesTheDirectSessionConnected)
      printf '%s\n' 'same-network first'
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
    printf '  (none)  — the whole suite, so both methods and both counterparts\n'
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
