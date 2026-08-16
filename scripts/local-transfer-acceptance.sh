#!/bin/bash
# Peer-to-peer transfer acceptance against a real, local, throwaway Relayium
# server.
#
# What this proves, and what it deliberately does not:
#
#   * PROVES a Nearby (same-network, code-less room) transfer and a pairing-code
#     transfer both complete between two SEPARATE PROCESSES over real WebRTC,
#     through a real Go server, with the received file names, sizes and SHA-256
#     digests matching what the sending side says it sent.
#   * PROVES the receiving side is the app's OWN machinery — the residency
#     socket, the offer classifier, the real RealtimeSessionModel and the real
#     writer — assembled through AppEnvironment exactly as RelayiumApp assembles
#     it, not a peer this script built.
#   * Does NOT drive a built App's UI. No Q0 matrix cell moves on this script's
#     evidence; the built-App UI paths are `ios-ui-session-acceptance.sh` (T2b,
#     unattended iOS Simulator) and T2c (batched owner-run macOS).
#
# The isolation rules — ephemeral ports, one per-run root, tokens in the
# environment, PID-exact cleanup, no release check, loopback-only STUN — and the
# reason each one exists live in `lib/local-acceptance.sh`, which this and the
# iOS UI acceptance run share. They were extracted there when the second caller
# appeared: a rule kept in two copies is a rule that gets fixed in one of them.

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
package_dir="$repo_root/apps/RelayiumKit"
server_dir="$repo_root/server"

# shellcheck source-path=SCRIPTDIR
# shellcheck source=lib/local-acceptance.sh
source "$repo_root/scripts/lib/local-acceptance.sh"

acceptance_begin
acceptance_build "$server_dir" "$package_dir"
acceptance_start_server
acceptance_create_account

# ── this run's own assertions ────────────────────────────────────────────────

# Waits for EVERY named peer to reach `done`, and stops the moment any one of
# them cannot.
#
# The version this replaces polled one peer to completion before looking at the
# other, and swallowed every probe error into `phase="?"`. When the receiver
# failed one second into a run, the script kept polling the sender for its full
# 150s timeout and then blamed the sender — which is how a deterministic ICE
# fault presented as "Nearby hangs for minutes". Three things changed:
#
#   * every participant is polled on every pass, so the FIRST side to fail is
#     the side that gets reported;
#   * a dead PID and an unreachable control API are failures with their own
#     messages, not an unknown phase that polls out the clock;
#   * the timeout is a real ceiling and the run stops there. It does not retry.
await_transfer() {
  local seconds="$1"; shift
  local deadline=$((SECONDS + seconds))
  local -a labels=("$@")
  local label port pid status phase remaining

  while [ "$SECONDS" -lt "$deadline" ]; do
    remaining=0
    for label in "${labels[@]}"; do
      local i=0 n=${#peer_labels[@]}
      port=""; pid=""
      while [ "$i" -lt "$n" ]; do
        if [ "${peer_labels[$i]}" = "$label" ]; then
          port="${peer_ports[$i]}"; pid="${peer_pids[$i]}"; break
        fi
        i=$((i + 1))
      done
      [ -n "$port" ] || fail "await_transfer was asked about unknown peer '$label'"

      kill -0 "$pid" 2>/dev/null \
        || fail "$label exited (pid $pid) before the transfer finished"

      status="$(control "$port" GET /status 2>/dev/null || true)"
      [ -n "$status" ] \
        || fail "$label stopped answering its control API on 127.0.0.1:$port"

      phase="$(json_field "$status" phase)"
      case "$phase" in
        done) ;;
        failed) fail "$label reported failed: $status" ;;
        *) remaining=$((remaining + 1)) ;;
      esac
    done
    [ "$remaining" -eq 0 ] && return 0
    sleep 0.5
  done
  fail "the transfer did not finish within ${seconds}s"
}

compare_receipts() {
  local sender_json="$1" receiver_json="$2" label="$3"
  python3 - "$sender_json" "$receiver_json" "$label" <<'PY'
import json, sys

sent = json.load(open(sys.argv[1]))
got = json.load(open(sys.argv[2]))
label = sys.argv[3]

def key(entry):
    # The path is what a rebuilt folder looks like; a receiver that flattened a
    # tree produces the same names under different paths, so the path is part of
    # the identity rather than a decoration.
    return entry.get("path") or entry["name"]

sent_files = {key(e): e for e in sent["files"]}
got_files = {key(e): e for e in got["files"]}

problems = []
if not sent_files:
    problems.append("the sender reported no files at all")
missing = sorted(set(sent_files) - set(got_files))
extra = sorted(set(got_files) - set(sent_files))
if missing:
    problems.append("never arrived: %s" % ", ".join(missing))
if extra:
    problems.append("arrived but was never sent: %s" % ", ".join(extra))
for name in sorted(set(sent_files) & set(got_files)):
    a, b = sent_files[name], got_files[name]
    if a["size"] != b["size"]:
        problems.append("%s size %d != %d" % (name, a["size"], b["size"]))
    if a["sha256"] != b["sha256"]:
        problems.append("%s sha256 %s != %s" % (name, a["sha256"], b["sha256"]))

for side, doc in (("sender", sent), ("receiver", got)):
    origin = doc.get("origin", "")
    if not origin.startswith("http://127.") and not origin.startswith("https://127."):
        problems.append("the %s resolved a non-loopback origin: %s" % (side, origin))

if problems:
    print("FAIL: %s\n  - %s" % (label, "\n  - ".join(problems)), file=sys.stderr)
    sys.exit(1)

print("-- %s: %d file(s) matched by name, path, size and SHA-256" % (label, len(sent_files)),
      file=sys.stderr)
for name in sorted(sent_files):
    e = sent_files[name]
    print("     %s  %8d  %s" % (e["sha256"][:16], e["size"], name), file=sys.stderr)
PY
}

# ── NEARBY ───────────────────────────────────────────────────────────────────

say "== NEARBY: the app's own resident machinery answers an offer nobody accepted =="
mkdir -p "$run_root/nearby-receive"
start_peer nearby-receiver nearby-receiver \
  --name "acceptance-receiver-$run_tag" \
  --receive-root "$run_root/nearby-receive"
receiver_port="$peer_port"

assert_control_api_is_guarded "$receiver_port"

start_peer nearby-sender nearby-sender \
  --name "acceptance-sender-$run_tag" \
  --counterpart "acceptance-receiver-$run_tag"
sender_port="$peer_port"

# Both peers exist and are answering their control APIs. This is the stage the
# cleanup test drives, because it is the first point at which a failure would
# strand real children.
maybe_fault after-nearby-peers

control "$receiver_port" POST /start >/dev/null
control "$sender_port" POST /start >/dev/null
await_transfer 150 nearby-sender nearby-receiver

control "$sender_port" GET /result >"$run_root/nearby-sent.json"
control "$receiver_port" GET /result >"$run_root/nearby-got.json"
compare_receipts "$run_root/nearby-sent.json" "$run_root/nearby-got.json" \
  "Nearby, peer to the app's own receiver"

# The bytes really are in files a person could open, in the run's own root and
# nowhere near anybody's Downloads folder.
#
# `-print -quit` rather than `find | head -1`: the pipe form can lose find to
# SIGPIPE under `set -o pipefail`.
[ -n "$(find "$run_root/nearby-receive" -type f -print -quit)" ] \
  || fail "the Nearby receive left no files in its own receive root"
say "-- the Nearby receive landed inside $run_root/nearby-receive"

# The sender is a `PlainPeer`, which announces no `link/1`, so this half must
# have gone over the LEGACY wire even though the receiving host now composes a
# link workspace too. Asserted rather than assumed: a receiver that had somehow
# routed a legacy peer into the link would still produce matching digests, and
# the one thing that would say so is a link that reported a peer.
observed="$(control "$receiver_port" GET /observed || true)"
case "$observed" in
  *'"linkPhase":"idle"'*) : ;;
  *) fail "a legacy PlainPeer was routed into the link workspace: $observed" ;;
esac
say "-- the legacy peer stayed on the legacy wire; the link reported no peer"

control "$receiver_port" POST /shutdown >/dev/null || true
control "$sender_port" POST /shutdown >/dev/null || true

# ── PAIRING ──────────────────────────────────────────────────────────────────

say "== PAIRING: a real minted code, joined by a second process =="
mkdir -p "$run_root/pair-send" "$run_root/pair-receive"

start_peer pair-receiver pair-receiver --receive-root "$run_root/pair-receive"
pair_receiver_port="$peer_port"

# The account bearer reaches this peer alone, through the environment rather than
# argv, and `start_peer` clears the slot afterwards.
peer_env=("RELAYIUM_ACCEPTANCE_ACCOUNT_TOKEN=$account_token")
start_peer pair-sender pair-sender --receive-root "$run_root/pair-send"
pair_sender_port="$peer_port"

maybe_fault after-pair-peers

control "$pair_sender_port" POST /start >/dev/null

# The code is minted by the sending peer through the product's own pair client,
# and read back off its status rather than minted a second time here.
pair_code=""
for _ in $(seq 1 100); do
  kill -0 "${peer_pids[$((${#peer_pids[@]} - 1))]}" 2>/dev/null \
    || fail "the pair sender exited before it minted a code"
  pair_status="$(control "$pair_sender_port" GET /status 2>/dev/null || true)"
  if [ -n "$pair_status" ]; then
    case "$(json_field "$pair_status" phase)" in
      failed) fail "the pair sender failed before minting: $pair_status" ;;
    esac
    pair_code="$(json_field "$pair_status" code)"
  fi
  [ -n "$pair_code" ] && break
  sleep 0.3
done
[ -n "$pair_code" ] || fail "the sender never minted a pairing code"
say "-- the local server minted pairing code $pair_code"

control "$pair_receiver_port" POST /start "{\"code\":\"$pair_code\"}" >/dev/null
await_transfer 150 pair-sender pair-receiver

control "$pair_sender_port" GET /result >"$run_root/pair-sent.json"
control "$pair_receiver_port" GET /result >"$run_root/pair-got.json"
compare_receipts "$run_root/pair-sent.json" "$run_root/pair-got.json" \
  "pairing code, app model to app model"

control "$pair_sender_port" POST /shutdown >/dev/null || true
control "$pair_receiver_port" POST /shutdown >/dev/null || true

assert_run_was_local

completed=1
say ""
say "PASS: Nearby and pairing transfers both completed peer-to-peer against"
say "      $origin with matching names, sizes and SHA-256 digests."
say "      No Q0 matrix cell is claimed: no built App UI path ran."
