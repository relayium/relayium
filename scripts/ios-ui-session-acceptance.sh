#!/bin/bash
# Q0-T2b: the built iOS app, driven through its own UI, completing real
# transfers against a real second endpoint.
#
# What this proves that `local-transfer-acceptance.sh` (T2a) does not:
#
#   * PROVES the BUILT APP's UI. T2a pairs two host processes and says so in its
#     own header — "No Q0 matrix cell moves on this script's evidence". This one
#     drives `RelayiumUITests/LocalSessionUITests` against a real simulator, so
#     the roster the user reads, the Connect they tap, the digits they compare
#     and the Done that returns them are all on the path.
#   * PROVES the app's Nearby roster names a real second endpoint, that Connect
#     establishes a `link/1`, that a staged batch and a typed message reach the
#     counterpart with matching SHA-256 digests, and that Done leaves no
#     half-session behind.
#   * PROVES the app joins a pairing code MINTED BY ANOTHER PROCESS on the local
#     server and drives it to a completed transfer.
#
# Which Q0 iOS cells this is the runtime path for:
#
#   Nearby → 创建/加入            testNearbyRosterNamesThePeerAndConnects
#   Nearby → 完成后下一步          testNearbyLinkTransfersThenDoneReturnsToACleanRoster
#   Direct (pairing) → 创建/加入   testDirectJoinsAMintedCodeAndCompletes
#   Direct (pairing) → 完成后下一步 testDirectJoinsAMintedCodeAndCompletes
#
# No macOS cell moves here: this boots an iOS Simulator and nothing else. The
# macOS built-App paths are T2c.
#
# ── the seam, and why the app can be pointed at this server at all ───────────
#
# `--relayium-transfer-origin` is `#if DEBUG` and admits loopback origins only —
# `AppEnvironment.loopbackTransferOrigin` is an allow-list of four address
# shapes, refuses `localhost` because a name is whatever the resolver says it
# is, and falls back to production on every failure. A shipped binary contains
# neither the argument name nor the parser. `UITestMode.allowsResidency` is
# `isActive && AppEnvironment.isLoopbackTransferOrigin`, which is what lets an
# acceptance launch join a code-less room at all: the public hub keys that room
# by observed public address, so a resident simulator would share a roster with
# strangers, and a loopback origin removes that reason rather than tolerating it.
#
# The isolation rules — ephemeral ports, one per-run root, tokens in the
# environment, PID-exact cleanup, no release check, loopback-only STUN — live in
# `lib/local-acceptance.sh` and are shared verbatim with T2a.
#
# ── usage ────────────────────────────────────────────────────────────────────
#
#   scripts/ios-ui-session-acceptance.sh [-only-testing:...]
#
# Any extra arguments are passed through to `xcodebuild`, so a single path can
# be driven while diagnosing one.

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
package_dir="$repo_root/apps/RelayiumKit"
server_dir="$repo_root/server"
project="$repo_root/apps/ios/Relayium.xcodeproj"

# shellcheck source-path=SCRIPTDIR
# shellcheck source=lib/local-acceptance.sh
source "$repo_root/scripts/lib/local-acceptance.sh"

acceptance_begin
acceptance_build "$server_dir" "$package_dir"
acceptance_start_server
acceptance_create_account

# ── the simulator ────────────────────────────────────────────────────────────
#
# Picked by id from the installed runtimes, exactly as `.github/workflows/
# macos.yml` picks one, so this stays independent of the device marketing name
# on each runner image.
#
# Its lifecycle is deliberately NOT managed here. `xcodebuild` boots what it
# needs, and a script that shut a simulator down afterwards would be shutting
# down whichever one a developer had open — the same class of mistake the
# PID-exact cleanup rule exists to prevent.
device_id="$(xcrun simctl list devices available -j \
  | python3 -c 'import json, sys
data = json.load(sys.stdin)
print(next((device["udid"]
            for devices in data["devices"].values()
            for device in devices
            if device.get("isAvailable")
            and device.get("name", "").startswith("iPhone")), ""))')"
[ -n "$device_id" ] || fail "no available iPhone Simulator runtime"
say "-- driving iPhone Simulator $device_id"

# ── the second endpoint ──────────────────────────────────────────────────────
#
# Started BEFORE the app so it is already in the room when the roster is first
# read. The name carries the run tag: a shared build agent may have another run
# resident, and a roster assertion that matched on a constant would pass against
# somebody else's peer.
mkdir -p "$run_root/nearby-receive" "$run_root/pair-send"

peer_name="acceptance-peer-$run_tag"
start_peer nearby-receiver nearby-receiver \
  --name "$peer_name" \
  --receive-root "$run_root/nearby-receive"
nearby_port="$peer_port"

assert_control_api_is_guarded "$nearby_port"

# The pairing half's minting side. It holds the account bearer, which reaches it
# through the environment and never through argv, and `start_peer` clears the
# slot immediately afterwards so no later peer inherits it.
peer_env=("RELAYIUM_ACCEPTANCE_ACCOUNT_TOKEN=$account_token")
start_peer pair-sender pair-sender --receive-root "$run_root/pair-send"
pair_port="$peer_port"

# Residency is started here rather than by the test: it is the state the app
# must find already true, and a room joined from inside the test would race the
# first roster read it is there to assert. The pairing peer is NOT started —
# a pairing code is short-lived and single-use, so the test mints it at the
# moment it is about to type it.
control "$nearby_port" POST /start >/dev/null
say "-- $peer_name is resident in the code-less room on $origin"

maybe_fault after-ios-peers

# ── the built app ────────────────────────────────────────────────────────────
#
# `xcodebuild` passes environment variables prefixed `TEST_RUNNER_` through to
# the test runner with the prefix stripped. The control bearer travels that way
# for the same reason it never reaches a peer's argv: argv on macOS is readable
# by every process this user runs, and a `-e` on the xcodebuild command line
# would publish it to the whole session for the length of a simulator boot.
export TEST_RUNNER_RELAYIUM_ACCEPTANCE_ORIGIN="$origin"
export TEST_RUNNER_RELAYIUM_ACCEPTANCE_CONTROL_TOKEN="$control_token"
export TEST_RUNNER_RELAYIUM_ACCEPTANCE_NEARBY_PORT="$nearby_port"
export TEST_RUNNER_RELAYIUM_ACCEPTANCE_NEARBY_NAME="$peer_name"
export TEST_RUNNER_RELAYIUM_ACCEPTANCE_PAIR_PORT="$pair_port"

# Inside the run root by default, so a local run leaves nothing behind and two
# concurrent runs cannot share a build. CI overrides it with the path the job's
# earlier `Build (unsigned, iOS Simulator)` step already populated: rebuilding
# the whole app from scratch here would add several minutes to every push for a
# binary the job is holding.
derived_data="${RELAYIUM_ACCEPTANCE_DERIVED_DATA:-$run_root/dd-ios}"

say "== driving RelayiumUITests/LocalSessionUITests against the built app =="
# ── why this is backgrounded and waited on, rather than run in the foreground ─
#
# Bash does not run a trapped INT/TERM while it is WAITING ON A FOREGROUND
# CHILD; it services the trap only once that child has exited. `xcodebuild test`
# is minutes long — a single failing UI path here has taken 134s, and a wedged
# simulator is unbounded — so a foreground call meant that for the whole of that
# window a SIGTERM to this launcher did nothing at all: the throwaway server,
# both peers and the booted simulator kept running, and a caller that had asked
# the run to stop had no way to make it. Measured, not assumed: a trapped
# handler behind a ten-second foreground `sleep` ran ten seconds late.
#
# Backgrounded and waited on instead, `wait` is interruptible, so the handler
# runs at once. The PID is REGISTERED first, so the cleanup that follows
# terminates `xcodebuild` by exact PID like every other child — this is why it
# is registered rather than left to be found by pattern, which the isolation
# rules forbid.
xcodebuild -project "$project" -scheme Relayium \
  -destination "platform=iOS Simulator,id=$device_id" \
  -derivedDataPath "$derived_data" \
  "${@:--only-testing:RelayiumUITests/LocalSessionUITests}" \
  test >"$run_root/xcodebuild.log" 2>&1 &
xcodebuild_pid=$!
register_child xcodebuild "$xcodebuild_pid"

xcodebuild_status=0
wait "$xcodebuild_pid" || xcodebuild_status=$?

if [ "$xcodebuild_status" -ne 0 ]; then
  say "-- xcodebuild failed ($xcodebuild_status); its last 80 lines follow"
  sed 's/^/   /' <(tail -80 "$run_root/xcodebuild.log") >&2 || true
  fail "the built-App UI paths did not pass"
fi

# The test asserted the receipts itself, against the same control API. This is
# the launcher's own independent read of the SAME peer, so a suite that had
# somehow passed without the counterpart ever receiving anything still fails
# here.
observed="$(control "$nearby_port" GET /observed)" \
  || fail "the counterpart stopped answering its control API"
# The CUMULATIVE fields, not the live ones. By the time this runs the app has
# gone, the link has ended and the counterpart has dismissed it — which is the
# right behaviour and would leave the live view reporting nothing about the run
# it just served.
python3 - "$observed" <<'PY' || fail "the counterpart received nothing"
import json, sys

facts = json.loads(sys.argv[1])
files = facts.get("allFiles") or []
messages = facts.get("allMessages") or []
problems = []
if not facts.get("epoch"):
    problems.append("the counterpart served no link at all, so the app's UI "
                    "reported a connection that never reached this process")
if not files:
    problems.append("no file receipt: the app's UI reported a transfer the "
                    "counterpart never wrote")
if not messages:
    problems.append("no message arrived over any link")
if problems:
    for problem in problems:
        print("  - %s" % problem, file=sys.stderr)
    sys.exit(1)

print("-- the counterpart served %d link(s), holding %d file receipt(s) and "
      "%d message(s)" % (facts["epoch"], len(files), len(messages)), file=sys.stderr)
for entry in files:
    print("     %s  %8d  %s"
          % (entry["sha256"][:16], entry["size"], entry.get("path") or entry["name"]),
          file=sys.stderr)
PY

# The bytes really are in files a person could open, in the run's own root and
# nowhere near anybody's Downloads folder.
[ -n "$(find "$run_root/nearby-receive" -type f -print -quit)" ] \
  || fail "the link receive left no files in its own receive root"
say "-- the link receive landed inside $run_root/nearby-receive"

control "$nearby_port" POST /shutdown >/dev/null || true
control "$pair_port" POST /shutdown >/dev/null || true

assert_run_was_local

completed=1
say ""
say "PASS: the built iOS app's own UI completed a Nearby link/1 transfer and a"
say "      pairing-code transfer against $origin, with matching SHA-256 digests."
