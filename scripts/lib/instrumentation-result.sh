#!/usr/bin/env bash
#
# **Did exactly one instrumentation test actually run, and pass?**
#
#   instrumentation-result.sh <log> [expected-tests]
#
# Exit 0 only when the answer is yes. Anything else — including every way an
# `am instrument` run can produce no result at all — is a failure.
#
# ## Why this is a separate program
#
# `am instrument` exits 0 almost unconditionally. It exits 0 when the process
# crashes, when the instrumentation cannot be found, when the target package is
# not installed, and when it printed nothing whatsoever. A driver that trusted
# the exit status, or that only grepped for the word FAILURES, therefore reports
# a green run for:
#
#   * `INSTRUMENTATION_ABORTED: System has crashed.` — the app died;
#   * `INSTRUMENTATION_STATUS: shortMsg=Process crashed.`;
#   * `INSTRUMENTATION_FAILED: … Unable to find instrumentation info` — nothing
#     ran, because the test APK was not installed;
#   * an empty log, because the command never started.
#
# Each of those is indistinguishable from success under a negative-only rule,
# and each is exactly the state a long emulator matrix produces when something
# is wrong with the device rather than with the product. So the rule here is
# POSITIVE: a specific number of tests must have been observed to finish OK, and
# the run must have reached a successful terminal, and none of the known
# failure markers may appear.
#
# It lives in its own file so `scripts/test/android-instrumentation-result-test.mjs`
# can execute THIS program against recorded logs, rather than re-implementing
# the rule in a second place and testing the copy.
set -Eeuo pipefail

log="${1:?usage: instrumentation-result.sh <log> [expected-tests]}"
expected="${2:-1}"

fail() { printf 'instrumentation-result: %s\n' "$*" >&2; exit 1; }

[ -f "$log" ] || fail "no log at $log — the run produced nothing"
[ -s "$log" ] || fail "the log is empty — am instrument printed nothing, so no test ran"

# ── the ways a run produces no usable result ────────────────────────────────
#
# Checked before the positive count, because several of them can coexist with a
# partially written status stream.
while IFS= read -r marker; do
  if grep -qF "$marker" "$log"; then
    fail "the run did not complete: found '$marker' in $log"
  fi
done <<'MARKERS'
INSTRUMENTATION_ABORTED
INSTRUMENTATION_FAILED
Unable to find instrumentation
Process crashed
Process crashed while executing
shortMsg=
INSTRUMENTATION_RESULT: shortMsg
FAILURES!!!
MARKERS

# `-2` is an assertion failure and `-1` an error, per
# android.app.Instrumentation's status codes. Either means a test ran and did
# not pass.
if grep -qE '^INSTRUMENTATION_STATUS_CODE: -[12]$' "$log"; then
  fail "a test reported failure (INSTRUMENTATION_STATUS_CODE -1/-2) in $log"
fi

# ── the positive evidence ───────────────────────────────────────────────────
#
# Status code 0 is emitted once per test that FINISHED OK. Counting it is what
# distinguishes "one test passed" from "nothing ran", which no negative check
# can do.
passed="$(grep -cE '^INSTRUMENTATION_STATUS_CODE: 0$' "$log" || true)"
[ "$passed" -eq "$expected" ] \
  || fail "expected $expected passing test(s), observed $passed in $log"

# …and the run itself must have terminated successfully. `-1` here is
# Activity.RESULT_OK; `0` is RESULT_CANCELED, which is what a killed run leaves.
grep -qE '^INSTRUMENTATION_CODE: -1$' "$log" \
  || fail "the instrumentation did not reach a successful terminal (no INSTRUMENTATION_CODE: -1) in $log"

printf 'instrumentation-result: %s test(s) passed\n' "$passed"
