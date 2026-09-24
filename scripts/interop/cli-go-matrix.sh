#!/usr/bin/env bash
#
# **A12: the CLI side of the pairing interop matrix, by exact test name.**
#
#   scripts/interop/cli-go-matrix.sh run   <linux|windows|darwin> <log>
#   scripts/interop/cli-go-matrix.sh judge <linux|windows|darwin> <log>
#
# `run` executes the named tests in `server/cmd/relayium` with `-v` into <log>
# and then judges it; `judge` only judges an existing log (the guard test
# `scripts/test/cli-interop-matrix-test.mjs` feeds it forged logs to prove each
# rule can fail).
#
# These are real CLI processes (the test binary re-executed in its CLI role)
# against the real signalling hub with pairing hints, on loopback: CLI↔CLI in
# both link roles with files, folders, texts, decline, rejected SAS, ctrl-C;
# `send`/`receive`/`text`/`pair` over link; the CLI against a Go-authored
# app/web peer (the MODEL cells); and — whenever RELAYIUM_OLD_CLI names the
# binary built from 723481c78 — the old-version pairs, which otherwise SKIP.
#
# ## What makes a green judgement
#
#   * every named test has its own top-level `--- PASS:` line. A renamed or
#     deleted test makes `-run` match nothing and `go test` still exits 0;
#   * NO `--- SKIP:` anywhere, subtests included, except the one listed below
#     with the exact reason its test states for it. In particular the old-
#     version tests may not skip: this lane exists so that they stop skipping;
#   * no `--- FAIL:`;
#   * the log shows the CLI on BOTH sides of the link role: a
#     `linked with another relayium CLI (…, initiator)` line and a
#     `(…, responder)` line, printed by the CLI processes themselves.
set -Eeuo pipefail

mode="${1:-}"
platform="${2:-}"
log="${3:-}"
case "$mode:$platform" in
  run:linux|run:windows|run:darwin|judge:linux|judge:windows|judge:darwin) ;;
  *) echo "usage: $0 run|judge linux|windows|darwin LOG" >&2; exit 2 ;;
esac
[ -n "$log" ] || { echo "usage: $0 run|judge linux|windows|darwin LOG" >&2; exit 2; }

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$here/../.." && pwd)"

# The cells every platform runs.
core=(
  TestLinkSinkReservedDeviceNames                  # actual filesystem names/bytes on each platform
  TestProductInputLossFailsTheRun                  # first line delivered before peer exit, input error retained
  TestPairInterleavedBatchesAndTextsBothWays        # cli↔cli: files, folder, texts, both directions, consecutive batches
  TestPairDeclinedBatchAndRejectedSASNeverWrite     # cli↔cli: decline, rejected SAS
  TestPairPeerNamesAndTextCannotForgeVerification   # cli↔cli: hostile names/text vs the SAS line
  TestProductSendReceiveAndPairInteroperateOverLink # send↔receive, send↔pair, pair↔receive over link
  TestProductTextOverLink                           # text↔text over link
  TestPairLeaveArrivesBeforeTheTransportCloses      # authenticated leave before the transport closes
  TestLinkDevNewToNewWithHints                      # discovery → link/1 between two new CLIs
  TestLinkDevNewToNewWithoutHints                   # a server without hints: legacy between new CLIs
  TestLinkDevBidirectionalLoopback                  # both lanes both ways
  TestLinkDevManySmallFiles                         # many-entry batches
  TestCrossnetLinksAnAppThatAnnouncesLink           # MODEL: the CLI against a Go-authored app peer
  TestCrossnetExplainsAnAppOrBrowserPeer            # MODEL: an app on a hint-less server
  TestCrossnetExplainsAnAppThatSpeaksBeforeTheRoster
)
# SIGINT cannot be delivered to one process on Windows.
posix_only=(
  TestInterruptIsALeaveAndNeverReportedSaved        # ctrl-C on either side mid-transfer
)
# The old-version pairs: need RELAYIUM_OLD_CLI (or the commit in local history).
old=(
  TestPairAgainstOlderCLIEndsFast
  TestProductCommandsKeepTheLegacyWireWithOlderCLI
  TestLinkDevAgainstOldCLI
)
# The ONE skip a green run may contain, with the reason its test states. It is
# a subtest that retries the legacy wire's own direct-connection race six times
# (A08d finding: it loses ~1 in 5 on hosts with TUN/CGNAT addresses) and says
# so rather than failing on a race that is not the code under test.
may_skip_re='^ *--- SKIP: TestLinkDevAgainstOldCLI/piped-text-new-to-old/(new-first|old-first) '
may_skip_reason="today's direct race never connected in 6 attempts on this host"

names=("${core[@]}" "${old[@]}")
if [ "$platform" != windows ]; then
  names+=("${posix_only[@]}")
fi

# The complete output of every failed top-level test, printed to the step log
# so a hosted failure is diagnosable without the log file (which go.yml also
# uploads, on failure). A run that never reached a FAIL line — a build error,
# a `-timeout` panic — shows the log's tail instead.
show_failures() {
  local f="$1" failed
  failed="$(grep -E '^--- FAIL: ' "$f" | awk '{print $3}' | sort -u || true)"
  if [ -z "$failed" ]; then
    echo "::group::cli-go-matrix: last 200 lines of $f (no top-level FAIL line)"
    tail -200 "$f"
    echo "::endgroup::"
    return 0
  fi
  local t
  for t in $failed; do
    echo "::group::cli-go-matrix: output of $t"
    # From its `=== RUN` line to its `--- FAIL` line; capped, keeping the end
    # (where the timeout message and both processes' transcripts are).
    awk -v t="$t" '
      $0 == "=== RUN   " t { on = 1 }
      on { print }
      on && index($0, "--- FAIL: " t " (") == 1 { exit }
    ' "$f" | tail -1500
    echo "::endgroup::"
  done
}

if [ "$mode" = run ]; then
  if [ -z "${RELAYIUM_OLD_CLI:-}" ]; then
    echo "::error::RELAYIUM_OLD_CLI is not set: the old-version pairs would build from local history or SKIP; this lane builds 723481c78 first" >&2
    exit 1
  fi
  old_path="$RELAYIUM_OLD_CLI"
  # Windows: the variable holds a native D:\ path for the Go test to exec.
  if command -v cygpath >/dev/null 2>&1; then old_path="$(cygpath -u "$old_path")"; fi
  [ -x "$old_path" ] || { echo "::error::RELAYIUM_OLD_CLI=$RELAYIUM_OLD_CLI is not an executable" >&2; exit 1; }
  regex="^($(IFS='|'; echo "${names[*]}"))\$"
  set +e
  (cd "$repo/server" && go test -count=1 -v -timeout 25m -run "$regex" ./cmd/relayium) >"$log" 2>&1
  status=$?
  set -e
  tail -5 "$log"
  if [ "$status" -ne 0 ]; then
    show_failures "$log"
    grep -E '^[[:space:]]*--- FAIL' "$log" >&2 || true
    echo "::error::go test exited $status" >&2
    exit 1
  fi
fi

[ -s "$log" ] || { echo "::error::no test log at $log" >&2; exit 1; }
problems=0
problem() { echo "::error::$*" >&2; problems=$((problems + 1)); }

for t in "${names[@]}"; do
  grep -q "^--- PASS: $t (" "$log" || problem "$t did not PASS on $platform"
done
if grep -qE '^[[:space:]]*--- FAIL' "$log"; then
  problem "a test FAILED: $(grep -E '^[[:space:]]*--- FAIL' "$log" | head -5 | tr '\n' ' ')"
fi
while IFS= read -r line; do
  if [[ "$line" =~ $may_skip_re ]]; then
    # The skip must carry its stated reason on the next lines of the log.
    grep -qF "$may_skip_reason" "$log" \
      || problem "a permitted subtest skipped without its stated reason: $line"
    continue
  fi
  problem "unexpected SKIP on $platform: $line"
done < <(grep -E '^[[:space:]]*--- SKIP:' "$log" || true)
# The link role, as the CLI processes themselves printed it.
grep -qE 'linked with another relayium CLI \(end-to-end encrypted link/1, initiator\)' "$log" \
  || problem "no CLI in the log was the link INITIATOR"
grep -qE 'linked with another relayium CLI \(end-to-end encrypted link/1, responder\)' "$log" \
  || problem "no CLI in the log was the link RESPONDER"

if [ "$problems" -ne 0 ]; then
  [ "$mode" = run ] && show_failures "$log"
  echo "cli-go-matrix: $problems problem(s) on $platform" >&2
  exit 1
fi
echo "cli-go-matrix: ${#names[@]} named CLI matrix tests PASSED on $platform; no unexpected SKIP; both link roles seen"
