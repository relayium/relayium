#!/bin/bash
# Proves that `local-transfer-acceptance.sh` strands nothing when it does NOT
# succeed.
#
# This exists because the launcher already leaked. `start_peer` was called as
# `port="$(start_peer …)"`, which ran it in a subshell: the peer was
# backgrounded there, the PID was appended to a copy of the registry that died
# with the substitution, and the live peer was reparented to PID 1. Three failed
# runs left three orphaned `LocalTransferPeer` processes behind, and nothing in
# the suite noticed — because every assertion was about a transfer that
# completed, and none was about what happens when one does not.
#
# So the property under test is the failure path itself:
#
#   A. an assertion fails while both Nearby peers are live  → non-zero exit,
#      nothing survives
#   B. the launcher is SIGTERMed while both peers are live  → dies OF SIGTERM
#      (143) without outliving it, nothing survives
#   C. the launcher is SIGINTed while both peers are live   → dies OF SIGINT
#      (130) without outliving it, nothing survives
#
# B and C assert the exit status the signal itself produces, not merely a
# non-zero one. A launcher that never received the signal and failed for its own
# unrelated reasons also exits non-zero, and that is not this property.
#
# "Nothing survives" means: no `LocalTransferPeer` and no throwaway
# `relayium-server` from THIS run tag is still running, and every child PID the
# launcher announced is gone.
#
# ── on how survivors are detected ────────────────────────────────────────────
#
# This scans `ps` output for the run tag. That is pattern matching over
# processes, and the launcher is forbidden from doing it — a pattern that
# matched a developer's own server or editor would be a script that ends other
# people's work, which is why the product code signals recorded PIDs and
# nothing else.
#
# The rule is about SIGNALLING, not observing, and the two are different acts.
# Nothing here ever signals a MATCHED process: the scan only reads, and it is
# the only way to prove ABSENCE — a launcher that forgot to record a PID would
# pass a check made solely against the PIDs it remembered.
#
# A survivor is still never killed on the strength of having matched. What IS
# reaped, and only after the failure has been recorded, is the separate set of
# PIDs the launcher itself ANNOUNCED — see `reap_stranded`. The two sets differ
# precisely when the launcher is broken, and the difference is the finding.
#
# Each run tag is 4 fresh bytes from /dev/urandom and appears in every child's
# argv, so the scan cannot match anything but this test's own processes.

set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
launcher="$script_dir/local-transfer-acceptance.sh"
[ -x "$launcher" ] || chmod +x "$launcher"

work="$(mktemp -d "${TMPDIR:-/tmp}/relayium-cleanup-test.XXXXXX")"
failures=0

say() { printf '%s\n' "$*" >&2; }

# shellcheck disable=SC2329  # invoked from the EXIT trap below
cleanup() {
  # The launcher under test is the only child this script starts, and each case
  # waits for it. This is the belt-and-braces path for a test that was itself
  # interrupted: exact PID, recorded, never a pattern.
  if [ -n "${launcher_pid:-}" ] && kill -0 "$launcher_pid" 2>/dev/null; then
    kill -TERM "$launcher_pid" 2>/dev/null || true
    wait "$launcher_pid" 2>/dev/null || true
  fi

  # An interrupted HARNESS must not strand what an interrupted launcher left.
  # Each case reaps its own on the way out, so this loop is normally a no-op;
  # it is here for the run that never reached that line. Every log names the
  # run tag and the announced PIDs its own case produced.
  local log tag
  if [ -d "$work" ]; then
    for log in "$work"/*.log; do
      [ -e "$log" ] || continue
      tag="$(run_tag_from "$log")"
      [ -n "$tag" ] && reap_stranded "$tag" "$log"
    done
  fi

  [ -d "$work" ] && rm -rf "$work"
  return 0
}
trap cleanup EXIT

# Every live PID whose argv mentions the tag. Read-only; see the header.
survivors_for_tag() {
  local tag="$1"
  # shellcheck disable=SC2009  # pgrep prints no argv, and the argv IS the
  # evidence: a survivor has to be reported with the command line that proves
  # it belongs to this run, not just as a bare PID.
  ps -eww -o pid= -o command= 2>/dev/null \
    | grep -F -- "$tag" \
    | grep -v -F -- 'local-transfer-cleanup-test' \
    | grep -v -F -- "grep" \
    || true
}

# Waits briefly for the run's processes to disappear, then reports whatever is
# left. The grace period is for a child that was SIGKILLed a moment ago, not a
# retry: a survivor that is still there after it is a real leak.
assert_nothing_survives() {
  local tag="$1" log="$2" case_name="$3"
  local waited=0 left=""
  while [ "$waited" -lt 50 ]; do
    left="$(survivors_for_tag "$tag")"
    [ -z "$left" ] && break
    sleep 0.1
    waited=$((waited + 1))
  done

  if [ -n "$left" ]; then
    say "  FAIL: $case_name left processes behind for run tag $tag:"
    printf '%s\n' "$left" | sed 's/^/    /' >&2
    failures=$((failures + 1))
    return 1
  fi

  # The same conclusion reached the other way: every PID the launcher said it
  # owned is gone. A PID is only counted as alive if its argv still mentions
  # the tag, so a recycled PID cannot masquerade as a survivor.
  local announced pid still=""
  announced="$(grep -o 'RELAYIUM_ACCEPTANCE_CHILD [a-z-]* [0-9]*' "$log" \
    | awk '{print $3}' || true)"
  if [ -z "$announced" ]; then
    say "  FAIL: $case_name announced no children at all, so it never reached"
    say "        the stage this test is about"
    failures=$((failures + 1))
    return 1
  fi
  for pid in $announced; do
    if kill -0 "$pid" 2>/dev/null; then
      if ps -ww -o command= -p "$pid" 2>/dev/null | grep -qF -- "$tag"; then
        still="$still $pid"
      fi
    fi
  done
  if [ -n "$still" ]; then
    say "  FAIL: $case_name left announced child PID(s) alive:$still"
    failures=$((failures + 1))
    return 1
  fi

  say "  ok: no LocalTransferPeer and no throwaway relayium-server survived"
  say "      ($(printf '%s' "$announced" | wc -w | tr -d ' ') announced child PIDs, all reaped)"
  return 0
}

# Ends whatever the launcher stranded, so a harness that exists to catch leaks
# does not itself leave three orphans on the machine every time it catches one.
#
# Ordering is the whole safety argument: this runs only AFTER
# `assert_nothing_survives` has recorded its verdict, so it can never turn a red
# assertion green or erase the evidence behind one.
#
# Nor does it contradict the header's read-only rule, which forbids signalling a
# process found BY PATTERN. Nothing pattern-matched is signalled here. Every PID
# is one the launcher announced on its own `RELAYIUM_ACCEPTANCE_CHILD` line, and
# each is re-checked against the run tag in its argv in the instant before the
# signal, so a recycled PID now belonging to somebody else cannot be hit. A
# survivor that was never announced is still only reported: killing something
# this harness cannot prove it started is exactly the mistake the rule prevents,
# and such a survivor is a launcher bug that a human needs to see anyway.
#
# Measured 2026-08-15: with the `start_peer` subshell defect reintroduced, all
# three cases stranded a PID-1 `LocalTransferPeer` that outlived the harness.
reap_stranded() {
  local tag="$1" log="$2"
  local announced pid reaped="" waited=0 alive=1

  announced="$(grep -o 'RELAYIUM_ACCEPTANCE_CHILD [a-z-]* [0-9]*' "$log" 2>/dev/null \
    | awk '{print $3}' || true)"
  for pid in $announced; do
    kill -0 "$pid" 2>/dev/null || continue
    ps -ww -o command= -p "$pid" 2>/dev/null | grep -qF -- "$tag" || continue
    kill -TERM "$pid" 2>/dev/null && reaped="$reaped $pid"
  done
  [ -n "$reaped" ] || return 0

  # The same bounded grace the launcher gives its own children, then insist.
  while [ "$waited" -lt 50 ] && [ "$alive" -eq 1 ]; do
    alive=0
    for pid in $reaped; do
      kill -0 "$pid" 2>/dev/null && alive=1
    done
    [ "$alive" -eq 1 ] || break
    sleep 0.1
    waited=$((waited + 1))
  done
  for pid in $reaped; do
    if kill -0 "$pid" 2>/dev/null \
      && ps -ww -o command= -p "$pid" 2>/dev/null | grep -qF -- "$tag"; then
      kill -KILL "$pid" 2>/dev/null || true
    fi
  done

  say "  (the harness reaped the stranded process(es):$reaped — this is cleanup"
  say "   after a launcher already proved broken; the FAIL above stands)"
  return 0
}

# Removes the run root the launcher keeps for diagnosis, so this test does not
# leak the very thing it is checking for.
drop_run_root() {
  local log="$1"
  local root
  root="$(grep -o -m1 'RELAYIUM_ACCEPTANCE_RUN_ROOT .*' "$log" | cut -d' ' -f2- || true)"
  case "$root" in
    */relayium-acceptance-*) rm -rf "$root" ;;
  esac
}

run_tag_from() {
  grep -o -m1 'RELAYIUM_ACCEPTANCE_RUN_TAG [0-9a-f]*' "$1" | awk '{print $2}' || true
}

# Waits until the launcher parks at its hold point, so the signal arrives with
# both peers genuinely running rather than before they exist.
await_hold() {
  local log="$1" pid="$2" waited=0
  while [ "$waited" -lt 1800 ]; do
    grep -q 'RELAYIUM_ACCEPTANCE_HOLDING' "$log" 2>/dev/null && return 0
    kill -0 "$pid" 2>/dev/null || return 1
    sleep 0.2
    waited=$((waited + 1))
  done
  return 1
}

# ── A: an assertion fails with both Nearby peers live ────────────────────────

say "== A: the launcher fails while both Nearby peers are running =="
log_a="$work/a.log"
status_a=0
RELAYIUM_ACCEPTANCE_FAULT=after-nearby-peers \
  "$launcher" >"$log_a" 2>&1 || status_a=$?
tag_a="$(run_tag_from "$log_a")"

if [ "$status_a" -eq 0 ]; then
  say "  FAIL: the injected fault did not fail the run (exit 0)"
  failures=$((failures + 1))
else
  say "  ok: the run failed as instructed (exit $status_a)"
fi
if [ -z "$tag_a" ]; then
  say "  FAIL: the launcher announced no run tag"
  failures=$((failures + 1))
else
  assert_nothing_survives "$tag_a" "$log_a" "case A" || true
  reap_stranded "$tag_a" "$log_a"
fi
# A failed run must keep its evidence; a cleanup that also erased the logs would
# make every future failure undiagnosable.
if grep -q 'run root kept for diagnosis' "$log_a"; then
  say "  ok: the failed run kept its run root for diagnosis"
else
  say "  FAIL: the failed run did not keep its run root"
  failures=$((failures + 1))
fi
drop_run_root "$log_a"

# ── B and C: the launcher is signalled with both peers live ──────────────────

for sig in TERM INT; do
  say "== $sig: the launcher is signalled while both Nearby peers are running =="
  log="$work/$sig.log"
  : >"$log"
  hold_seconds=120

  # `set -m` is what makes this case a test at all.
  #
  # A non-interactive shell starts an `&` child with SIGINT set to IGNORED, and
  # bash cannot re-arm a signal that was ignored on entry. So the launcher's own
  # `trap 'on_signal INT' INT` never installed, the SIGINT below was discarded
  # outright, and the launcher sat at its hold point for the full 120s before
  # failing with "never signalled" — which the old `-ne 0` check below accepted
  # as a pass. The case reported ok while testing nothing.
  #
  # Measured 2026-08-15 on an isolated probe of this exact shape: without
  # `set -m` the trap never fires and the child has to be killed from outside;
  # with it, the trap fires in ~1s. Job control also puts the launcher in its
  # own process group, which the signalling below depends on.
  set -m
  RELAYIUM_ACCEPTANCE_FAULT="hold:after-nearby-peers" \
    RELAYIUM_ACCEPTANCE_HOLD_SECONDS="$hold_seconds" \
    "$launcher" >"$log" 2>&1 &
  launcher_pid=$!
  set +m

  if await_hold "$log" "$launcher_pid"; then
    # The launcher PROCESS, never `-$launcher_pid`. Signalling the group would
    # also hit whatever the launcher stranded — those orphans keep the group
    # they were started in, because reparenting to PID 1 changes the parent and
    # not the process group — and the leak this case exists to catch would be
    # cleaned up by the signal itself and never observed. That is precisely the
    # false negative a group-wide interrupt produced on 2026-08-15.
    signalled_at=$SECONDS
    kill -"$sig" "$launcher_pid" 2>/dev/null || true
    status=0
    wait "$launcher_pid" 2>/dev/null || status=$?
    elapsed=$((SECONDS - signalled_at))
    launcher_pid=""
    tag="$(run_tag_from "$log")"
    say "  ok: the launcher parked with both peers live, took SIG$sig, exited ($status after ${elapsed}s)"

    # 128+signum, because `on_signal` re-raises the signal once its own cleanup
    # is done. Asserting merely "non-zero" is what let a launcher that was never
    # signalled at all — and simply timed out — read as a pass.
    case "$sig" in
      TERM) expected=143 ;;
      INT) expected=130 ;;
      *) expected=0 ;;
    esac
    if [ "$status" -ne "$expected" ]; then
      say "  FAIL: SIG$sig should leave exit $expected (128+signum, re-raised after"
      say "        the launcher's own cleanup); it exited $status instead"
      if [ "$status" -eq 0 ]; then
        say "        exit 0 is indistinguishable from a passing run"
      elif [ "$elapsed" -ge "$hold_seconds" ]; then
        say "        and it took ${elapsed}s, i.e. it ran the ${hold_seconds}s hold out:"
        say "        the signal never reached the launcher, so nothing was tested"
      fi
      failures=$((failures + 1))
    else
      say "  ok: SIG$sig killed the launcher with $expected, after its own cleanup"
    fi

    # A handler that only runs once the hold has expired is not a handler.
    if [ "$elapsed" -ge 30 ]; then
      say "  FAIL: the launcher took ${elapsed}s to die after SIG$sig; it must react"
      say "        to the signal, not outlive it"
      failures=$((failures + 1))
    fi

    if [ -z "$tag" ]; then
      say "  FAIL: the launcher announced no run tag"
      failures=$((failures + 1))
    else
      assert_nothing_survives "$tag" "$log" "case $sig" || true
      reap_stranded "$tag" "$log"
    fi
  else
    say "  FAIL: the launcher never reached its hold point"
    failures=$((failures + 1))
    if [ -n "${launcher_pid:-}" ] && kill -0 "$launcher_pid" 2>/dev/null; then
      kill -TERM "$launcher_pid" 2>/dev/null || true
      wait "$launcher_pid" 2>/dev/null || true
    fi
    launcher_pid=""
    tag="$(run_tag_from "$log")"
    [ -n "$tag" ] && reap_stranded "$tag" "$log"
  fi
  drop_run_root "$log"
done

say ""
if [ "$failures" -eq 0 ]; then
  say "PASS: the acceptance launcher terminates and reaps every child it starts"
  say "      on the assertion-failure, SIGTERM and SIGINT paths."
  exit 0
fi
say "FAIL: $failures cleanup assertion(s) failed."
exit 1
