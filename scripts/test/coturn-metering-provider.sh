#!/usr/bin/env bash
# F02 real-provider reconciliation: real coturn 4.6.1 + real Redis + the
# relayium-coturn-bridge binary + the real central ingest and SQLite ledger,
# all on loopback. No production contact, no credentials: every secret is
# generated per run and lives only in a private temp directory.
#
# Usage:
#   scripts/test/coturn-metering-provider.sh <coturn-bin-dir> <evidence-dir>
#
# <coturn-bin-dir> holds turnserver (coturn 4.6.1). redis-server must be on
# PATH. RELAYIUM_COTURN_PROVIDER_OUTAGE (default 5m) sets how long central is
# down in the outage scenario. The run takes ~15 minutes: the natural-expiry
# scenario waits for coturn's 600 s default allocation lifetime. Both provider
# tests run: the 11-scenario reconciliation matrix and S12 (owner purged while
# live, then drain).
#
# RELAYIUM_COTURN_PROVIDER_SUITE selects what runs (default: full):
#   full        the 11-scenario matrix + S12 (unchanged)
#   transports  TCP and TLS clients (T1-T5), ~1 minute
#   concurrent  concurrent UDP/TCP/TLS allocations across relay threads
#   systemd     the systemd MainPID epoch-source controls, plus the read-only
#               probe of RELAYIUM_COTURN_PROVIDER_SYSTEMD_UNIT when it is set
#   all         full + transports + concurrent + systemd, in one run of the
#               same prebuilt binaries (the probe only when the unit is set)
#   admission   OPS9: coturn's own `tc no-udp-relay` admission gate on the
#               fixture coturn (never production); not part of `all`
# RELAYIUM_COTURN_PROVIDER_RELAY_THREADS (1 = the pinned fixture, "default" =
# coturn's own CPU-based count, or a number) passes through to the tests.
#
# Provenance: before compiling, every execution input (all tracked files at
# their working-tree content and every untracked, non-ignored file) is hashed
# into inputs-before.txt; the bridge and the test binary are then built once,
# hashed, and those exact binaries run. After the run the inputs are hashed
# again and must be identical.
set -euo pipefail
suite="${RELAYIUM_COTURN_PROVIDER_SUITE:-full}"
case "$suite" in
  full) tests="TestCoturnMeteringProviderReconciliation TestCoturnMeteringProviderPurgedDrain" ;;
  transports) tests="TestCoturnMeteringProviderTransports" ;;
  concurrent) tests="TestCoturnMeteringProviderConcurrentThreads" ;;
  systemd) tests="TestCoturnBridgeSystemdMainPIDEpochSource" ;;
  admission) tests="TestCoturnMeteringProviderAdmissionGate" ;;
  all) tests="TestCoturnMeteringProviderReconciliation TestCoturnMeteringProviderPurgedDrain TestCoturnMeteringProviderTransports TestCoturnMeteringProviderConcurrentThreads TestCoturnBridgeSystemdMainPIDEpochSource" ;;
  *) echo "unknown RELAYIUM_COTURN_PROVIDER_SUITE=$suite" >&2; exit 2 ;;
esac
case "$suite" in
  systemd|all)
    if [ -n "${RELAYIUM_COTURN_PROVIDER_SYSTEMD_UNIT:-}" ]; then tests="$tests TestCoturnProviderSystemdMainPIDProbe"; fi ;;
esac
run_regex="^($(echo "$tests" | tr ' ' '|'))\$"
here="$(cd "$(dirname "$0")/../.." && pwd)"
bin="${1:?coturn bin dir}"
evid="${2:?evidence dir}"
[ -x "$bin/turnserver" ] || { echo "no turnserver in $bin" >&2; exit 2; }
"$bin/turnserver" --version 2>/dev/null | grep -q '^4\.6\.1' || { echo "turnserver in $bin is not 4.6.1" >&2; exit 2; }
command -v redis-server >/dev/null || { echo "redis-server not on PATH" >&2; exit 2; }
mkdir -p "$evid"
sha() { if command -v sha256sum >/dev/null; then sha256sum "$1"; else shasum -a 256 "$1"; fi | cut -d' ' -f1; }
work="$(mktemp -d /tmp/cm-prov-bin-XXXXXX)"
trap 'rm -rf "$work"' EXIT

inventory() {
  # All tracked paths (working-tree content) plus untracked non-ignored files.
  { git -C "$here" ls-files; git -C "$here" ls-files --others --exclude-standard; } | sort -u | while read -r f; do
    if [ -f "$here/$f" ]; then
      echo "$(sha "$here/$f")  $f"
    else
      echo "absent  $f"
    fi
  done
}

inventory > "$evid/inputs-before.txt"
{
  echo "suite: $suite ($tests)"
  echo "systemd unit probed (read-only): ${RELAYIUM_COTURN_PROVIDER_SYSTEMD_UNIT:-none}"
  echo "relay threads mode: ${RELAYIUM_COTURN_PROVIDER_RELAY_THREADS:-1}; host CPUs: $(getconf _NPROCESSORS_ONLN 2>/dev/null || echo unknown)"
  echo "product HEAD: $(git -C "$here" rev-parse HEAD)"
  echo "inputs fingerprint (sha256 of inputs-before.txt): $(sha "$evid/inputs-before.txt")"
  echo "inputs: $(wc -l < "$evid/inputs-before.txt" | tr -d ' ') files"
  echo "tracked diff sha256: $(git -C "$here" diff HEAD > "$work/tracked.diff"; sha "$work/tracked.diff")"
  echo "untracked files:"
  git -C "$here" ls-files --others --exclude-standard | sort | while read -r f; do
    echo "  $(sha "$here/$f")  $f"
  done
  echo "go: $(cd "$here/server" && go version) GOTOOLCHAIN=$(cd "$here/server" && go env GOTOOLCHAIN) GOVERSION=$(cd "$here/server" && go env GOVERSION)"
  echo "turnserver: $("$bin/turnserver" --version 2>&1 | head -1) sha256 $(sha "$bin/turnserver")"
  echo "redis-server: $(redis-server --version) sha256 $(sha "$(command -v redis-server)")"
} > "$evid/run-env.txt"

cd "$here/server"
go build -o "$work/relayium-coturn-bridge" ./cmd/relayium-coturn-bridge
go test -c -o "$work/coturn-provider.test" .
{
  echo "bridge binary sha256: $(sha "$work/relayium-coturn-bridge")"
  echo "test binary sha256: $(sha "$work/coturn-provider.test")"
  go version -m "$work/relayium-coturn-bridge" | head -3 | sed 's/^/bridge build: /'
  echo "started: $(date -u +%FT%TZ)"
} >> "$evid/run-env.txt"

set +e
RELAYIUM_COTURN_PROVIDER_BIN="$bin" RELAYIUM_COTURN_PROVIDER_EVIDENCE="$evid" \
  RELAYIUM_COTURN_PROVIDER_BRIDGE_BIN="$work/relayium-coturn-bridge" \
  "$work/coturn-provider.test" -test.run "$run_regex" -test.count=1 -test.v -test.timeout 45m 2>&1 \
  | grep -v 'sqlite: ensuring index' | tee "$evid/go-test.log"
rc=${PIPESTATUS[0]}
set -e
echo "finished: $(date -u +%FT%TZ) exit $rc" >> "$evid/run-env.txt"

inventory > "$evid/inputs-after.txt"
if ! cmp -s "$evid/inputs-before.txt" "$evid/inputs-after.txt"; then
  echo "execution inputs changed during the run:" >&2
  diff "$evid/inputs-before.txt" "$evid/inputs-after.txt" >&2 || true
  echo "inputs changed during run: FAIL" >> "$evid/run-env.txt"
  exit 1
fi
echo "inputs unchanged through the run: yes" >> "$evid/run-env.txt"
for t in $tests; do
  grep -q "^--- PASS: $t " "$evid/go-test.log" || { echo "$t did not PASS" >&2; exit 1; }
done
exit "$rc"
