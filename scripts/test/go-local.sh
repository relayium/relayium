#!/usr/bin/env bash
# Local Go test runner: the server's ordinary `go test` lane plus the A11
# relay-renewal driver tests, with the same selectors CI uses.
#
#   scripts/test/go-local.sh            # ordinary, then renewal
#   scripts/test/go-local.sh ordinary   # ordinary only (minutes)
#   scripts/test/go-local.sh renewal    # renewal only (~20 minutes, real time)
#
# Works from any directory. Set GO_LOCAL_LOG_DIR to keep the logs somewhere
# specific; otherwise they go to a fresh temporary directory, printed at the end.
#
# Why not plain `cd server && go test ./...`: the TestLinkRenew*/TestLDRenew*
# tests wait out 100-300 s relay credentials in REAL time (~1183 s together),
# which pushes server/cmd/relayium past Go's 10-minute per-package default. CI
# (.github/workflows/go.yml) therefore skips them in `test` and runs them in
# `link-renew`; this script runs the same two halves:
#
#   ordinary  `go test -count=1 -timeout 10m -skip <pattern> ./...`
#             — go.yml `test`, with Go's default 10m bound written out and
#             -count=1 so a cached PASS cannot stand in for a run.
#   renewal   `go test -race -count=1 -v -timeout 35m -run <pattern> ./cmd/relayium`
#             — go.yml `link-renew`, verbatim. Every top-level test the
#             pattern names in cmd/relayium/*_test.go must print a PASS line,
#             none may SKIP, and an empty set is a failure.
#
# It is a SUBSET of the Go workflow, not a replacement: no go build/vet, no
# race shards of ./account or the other packages, no CLI pairing matrix
# (old-CLI pairs), no Windows runtime tests, no govulncheck, no rollback
# harness. See docs/CI-PLATFORM-BOUNDARY.md.
#
# No retries: a failing lane stops the script with a non-zero status. Exceeding
# a -timeout is a hung test, not a number to raise.
# scripts/test/ci-event-policy-test.mjs asserts the selectors here stay equal to
# go.yml's and drives this script against a fake `go` for its failure paths.
set -euo pipefail

RENEW_PATTERN='^(TestLinkRenew|TestLDRenew)'
ORDINARY_TIMEOUT=10m
RENEW_TIMEOUT=35m

mode=${1:-all}
case "$mode" in
  all | ordinary | renewal) ;;
  *)
    echo "usage: $0 [all|ordinary|renewal]" >&2
    exit 2
    ;;
esac

here=$(CDPATH='' cd -P -- "$(dirname -- "$0")" && pwd -P)
server=$(CDPATH='' cd -P -- "$here/../../server" && pwd -P)
log_dir=${GO_LOCAL_LOG_DIR:-$(mktemp -d "${TMPDIR:-/tmp}/go-local.XXXXXX")}
mkdir -p "$log_dir"
# Absolute before the cd below, so a relative GO_LOCAL_LOG_DIR means the caller's directory.
log_dir=$(CDPATH='' cd -P -- "$log_dir" && pwd -P)

fail() {
  echo "go-local: FAIL: $*" >&2
  echo "go-local: logs in $log_dir" >&2
  exit 1
}

# Discovered before anything runs, so an empty or renamed set fails in seconds
# rather than after the ordinary lane.
want=""
if [ "$mode" != ordinary ]; then
  want=$(cd "$server" && { grep -hoE "^func ${RENEW_PATTERN#^}[A-Za-z0-9_]*" cmd/relayium/*_test.go || true; } | awk '{print $2}')
  [ -n "$want" ] || fail "no top-level test in server/cmd/relayium matches $RENEW_PATTERN"
fi

cd "$server"

if [ "$mode" != renewal ]; then
  echo "go-local: [ordinary] (cd $server && go test -count=1 -timeout $ORDINARY_TIMEOUT -skip '$RENEW_PATTERN' ./...)"
  go test -count=1 -timeout "$ORDINARY_TIMEOUT" -skip "$RENEW_PATTERN" ./... ||
    fail "ordinary lane exited non-zero"
  echo "go-local: [ordinary] PASS"
fi

if [ "$mode" != ordinary ]; then
  log="$log_dir/renewal.log"
  echo "go-local: [renewal] (cd $server && go test -race -count=1 -v -timeout $RENEW_TIMEOUT -run '$RENEW_PATTERN' ./cmd/relayium) > $log"
  # pipefail (set above) carries go's status through tee.
  go test -race -count=1 -v -timeout "$RENEW_TIMEOUT" -run "$RENEW_PATTERN" ./cmd/relayium 2>&1 | tee "$log" ||
    fail "renewal lane exited non-zero"
  n=0
  for t in $want; do
    grep -q "^--- PASS: $t " "$log" || fail "renewal test $t did not PASS"
    n=$((n + 1))
  done
  if grep -E '^ *--- SKIP: ' "$log" >&2; then
    fail "a renewal test skipped"
  fi
  echo "go-local: [renewal] PASS ($n top-level tests, each with a PASS line, no SKIP)"
fi

echo "go-local: OK ($mode); logs in $log_dir"
