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
#     evidence; the built-App UI paths are T2b/T2c.
#
# Isolation, and why each piece is here rather than convenient:
#
#   * Every port is ephemeral (:0 / kernel-assigned). A fixed port is how two
#     concurrent runs on one machine end up talking to each other's server.
#   * The database, the blob directory, both receive roots and every log live
#     under ONE per-run temporary root, removed on the way out.
#   * The receive roots are inside that root and are passed explicitly. The
#     product's own default receive directory is the user's Downloads folder,
#     and a run that fell back to it would write real files into a real person's
#     folder.
#   * Tokens are passed in the ENVIRONMENT and never in argv, because argv on
#     macOS is readable by every process this user runs.
#   * Cleanup kills exactly the PIDs this script started. There is no `pkill`
#     and no pattern match: a pattern that matched a developer's own editor,
#     server or debugger would be a script that ends other people's work.
#   * RELAYIUM_RELEASE_CHECK=false. The server otherwise asks api.github.com for
#     the newest release at startup, which is a real outbound request from a run
#     whose whole claim is that it makes none.
#
# ── the STUN entry, and why "no ICE at all" was wrong ────────────────────────
#
# This used to start the server with no STUN configuration and then assert that
# `/api/ice` answered `{"iceServers":null}`, on the reasoning that a local run
# needs no ICE server at all. That assertion was mutually exclusive with the
# product's own contract and made the Nearby half impossible to pass:
#
#   `parseICEConfig` (RelayiumKit/Account/ICEClient.swift) treats an absent or
#   empty `iceServers` as a hard configuration failure — `throw
#   AccountError.decoding` — deliberately, because a peer connection with no ICE
#   servers fails later and much more obscurely. So the receiver, answering an
#   unsolicited offer through the app's real machinery, fetched `/api/ice`, got
#   null, and went straight to `.failed` with the account-decoding copy about a
#   millisecond into the transfer.
#
# The server is therefore configured with ONE STUN URL pointing at loopback.
# Nothing listens on it, and nothing needs to: two peers on one machine pair on
# host candidates, and `RealtimeConnectionFactory.nearbyICEServers` filters the
# response to STUN-only anyway. What the loopback URL buys is that the app's
# fail-closed rule is satisfied by a value that cannot leave this machine, so
# the run exercises the shipped path instead of a path no user has.
#
# The assertion below is correspondingly stronger than the one it replaced: it
# requires the list to be non-empty (the app's precondition), every entry to be
# STUN rather than a relay, every host to be loopback, and no relay pool or
# credential to be offered. A public STUN entry now fails the run rather than
# passing it quietly.

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
package_dir="$repo_root/apps/RelayiumKit"
server_dir="$repo_root/server"

# Nothing listens here. See the header: this exists to satisfy the app's
# non-empty-iceServers precondition with a value that cannot leave the machine.
loopback_stun="stun:127.0.0.1:3478"

# ── per-run state ────────────────────────────────────────────────────────────

run_tag="$(od -An -tx1 -N4 /dev/urandom | tr -d ' \n')"
run_root="$(mktemp -d "${TMPDIR:-/tmp}/relayium-acceptance-${run_tag}.XXXXXX")"

# Every process this script started, in start order, with a label for
# diagnosis. Appended to from the TOP-LEVEL shell only — see `start_peer`.
declare -a child_labels=()
declare -a child_pids=()

# The subset that speaks the loopback control API.
declare -a peer_labels=()
declare -a peer_ports=()
declare -a peer_pids=()

say() { printf '%s\n' "$*" >&2; }

# Machine-readable lines for the cleanup test (and for a human reading a failed
# run): every child this script owns is announced as it starts, so an external
# observer can prove afterwards that none of them survived.
emit() { printf '%s\n' "$*" >&2; }

emit "RELAYIUM_ACCEPTANCE_RUN_TAG $run_tag"
emit "RELAYIUM_ACCEPTANCE_RUN_ROOT $run_root"

# ── child lifecycle ──────────────────────────────────────────────────────────
#
# `terminate_children` is idempotent and safe to call twice: cleanup runs from
# the EXIT trap, and a signal handler may have run it already.

terminate_children() {
  local n=${#child_pids[@]}
  [ "$n" -gt 0 ] || return 0

  # A polite TERM to every live child FIRST, so they shut down concurrently
  # rather than each waiting out its own grace period in turn.
  local i=0 pid
  while [ "$i" -lt "$n" ]; do
    pid="${child_pids[$i]}"
    if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
      kill -TERM "$pid" 2>/dev/null || true
    fi
    i=$((i + 1))
  done

  # One shared bounded grace period (up to ~5s), then insist — still only on
  # PIDs this script recorded.
  local waited=0 alive=1
  while [ "$waited" -lt 50 ] && [ "$alive" -eq 1 ]; do
    alive=0
    i=0
    while [ "$i" -lt "$n" ]; do
      pid="${child_pids[$i]}"
      if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then alive=1; fi
      i=$((i + 1))
    done
    [ "$alive" -eq 1 ] || break
    sleep 0.1
    waited=$((waited + 1))
  done

  i=0
  while [ "$i" -lt "$n" ]; do
    pid="${child_pids[$i]}"
    if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
      say "-- ${child_labels[$i]} (pid $pid) ignored SIGTERM; sending SIGKILL"
      kill -KILL "$pid" 2>/dev/null || true
    fi
    i=$((i + 1))
  done

  # Reap. These are children of THIS shell — which is the whole point of
  # starting them at the top level — so `wait` actually collects them instead
  # of leaving zombies behind.
  i=0
  while [ "$i" -lt "$n" ]; do
    pid="${child_pids[$i]}"
    [ -n "$pid" ] && wait "$pid" 2>/dev/null || true
    i=$((i + 1))
  done

  child_pids=()
  child_labels=()
  return 0
}

# Everything known about a failed run, printed once, at the point of failure.
#
# This is the decisive-diagnosis requirement: a run that stops must say which
# side failed and why, rather than leaving a timeout to be attributed to
# whichever peer the script happened to poll first.
diagnose() {
  local n=${#peer_labels[@]} i=0 label port pid status
  say ""
  say "── run diagnosis ────────────────────────────────────────────────────"
  say "run tag:  $run_tag"
  say "run root: $run_root"
  while [ "$i" -lt "$n" ]; do
    label="${peer_labels[$i]}"; port="${peer_ports[$i]}"; pid="${peer_pids[$i]}"
    if kill -0 "$pid" 2>/dev/null; then
      # `${control_token:-}` because a failure can happen before the token
      # exists, and `set -u` would turn the diagnosis itself into the error.
      status="$(curl -sf --max-time 5 -H "Authorization: Bearer ${control_token:-}" \
        "http://127.0.0.1:$port/status" 2>/dev/null || echo '<control API unreachable>')"
      say "-- $label (pid $pid, alive): $status"
    else
      say "-- $label (pid $pid, EXITED)"
    fi
    if [ -s "$run_root/$label.log" ]; then
      say "   ---- $label.log (last 40 lines)"
      sed 's/^/   /' <(tail -40 "$run_root/$label.log") >&2 || true
    fi
    i=$((i + 1))
  done
  if [ -s "$run_root/server.log" ]; then
    say "   ---- server.log (last 20 lines)"
    sed 's/^/   /' <(tail -20 "$run_root/server.log") >&2 || true
  fi
  say "─────────────────────────────────────────────────────────────────────"
}

# A failure is terminal. Nothing here retries: a run that quietly tried again
# would turn a reproducible protocol fault into an intermittent one.
fail() {
  say "FAIL: $*"
  diagnose
  exit 1
}

# Set to 1 on the last line of the run, and nowhere else.
#
# It exists because a signal does NOT reliably reach the handlers below. Bash
# does not run a trapped INT while it is waiting on a foreground child: the
# measured behaviour is that the shell exits, the INT trap never fires, and —
# if no command had failed yet — it exits 0. An interrupted acceptance run that
# reported success would be the worst failure mode this script has, so the EXIT
# trap refuses a zero status that did not come from reaching the end.
completed=0

cleanup() {
  local status=$?
  trap - EXIT INT TERM HUP
  if [ "$status" -eq 0 ] && [ "$completed" -ne 1 ]; then
    say "-- the run ended before reaching its PASS line, so it was interrupted"
    say "   or abandoned; reporting failure rather than an unearned success"
    status=1
  fi
  terminate_children
  if [ "$status" -ne 0 ] && [ -d "$run_root" ]; then
    say "--- run root kept for diagnosis: $run_root"
  elif [ -d "$run_root" ]; then
    rm -rf "$run_root"
  fi
  exit "$status"
}

on_signal() {
  local sig="$1"
  trap - EXIT INT TERM HUP
  say ""
  say "-- interrupted by SIG$sig: terminating ${#child_pids[@]} owned child process(es)"
  terminate_children
  [ -d "$run_root" ] && say "--- run root kept for diagnosis: $run_root"
  # Re-raise so whoever signalled us observes a real signal death rather than
  # an ordinary exit status.
  kill -"$sig" $$
}

trap cleanup EXIT
trap 'on_signal INT' INT
trap 'on_signal TERM' TERM
trap 'on_signal HUP' HUP

# ── fault injection, for the cleanup test only ───────────────────────────────
#
# RELAYIUM_ACCEPTANCE_FAULT names a stage at which this run must fail, or
# `hold:<stage>` to park there until something signals us. Both exist so
# `local-transfer-cleanup-test.sh` can drive the failure and interrupt paths
# with real children running.
#
# It can only ever make a run FAIL. There is no value that skips an assertion,
# shortens a wait or fabricates a receipt, so a stray setting in a real run
# turns into a loud failure rather than a false pass.
maybe_fault() {
  local stage="$1"
  case "${RELAYIUM_ACCEPTANCE_FAULT:-}" in
    "$stage")
      say "-- fault injection: failing at stage '$stage' on purpose"
      fail "injected fault at stage '$stage'"
      ;;
    "hold:$stage")
      emit "RELAYIUM_ACCEPTANCE_HOLDING $stage"
      say "-- fault injection: holding at stage '$stage' to be signalled"
      # Short sleeps against a real deadline rather than one long one: a signal
      # can cut a `sleep` short without the trap having run, and a single
      # `sleep N; fail` would then report "never signalled" about a run that was
      # signalled a moment earlier.
      local limit="${RELAYIUM_ACCEPTANCE_HOLD_SECONDS:-120}"
      local started=$SECONDS
      while [ $((SECONDS - started)) -lt "$limit" ]; do
        sleep 1
      done
      fail "held at stage '$stage' for ${limit}s and was never signalled"
      ;;
  esac
}

# A free TCP port from the kernel, released immediately before it is claimed.
# The window is a real (small) race; the alternative — a fixed port — is a
# certainty rather than a race.
free_port() {
  python3 -c 'import socket
s = socket.socket()
s.bind(("127.0.0.1", 0))
print(s.getsockname()[1])
s.close()'
}

# ── build ────────────────────────────────────────────────────────────────────

say "== building the local server and the acceptance peer =="
( cd "$server_dir" && go build -o "$run_root/relayium-server" . )
( cd "$package_dir" && swift build --product LocalTransferPeer >/dev/null )
peer_binary="$(cd "$package_dir" && swift build --product LocalTransferPeer --show-bin-path)/LocalTransferPeer"
[ -x "$peer_binary" ] || fail "the acceptance peer did not build"

# ── the server ───────────────────────────────────────────────────────────────

server_port="$(free_port)"
origin="http://127.0.0.1:$server_port"
mkdir -p "$run_root/blobs"

say "== starting a throwaway server on $origin =="
RELAYIUM_RELEASE_CHECK=false \
  "$run_root/relayium-server" \
  -addr "127.0.0.1:$server_port" \
  -db "$run_root/relayium.db" \
  -blob-dir "$run_root/blobs" \
  -stun-urls "$loopback_stun" \
  >"$run_root/server.log" 2>&1 &
server_pid=$!
child_labels+=("server")
child_pids+=("$server_pid")
emit "RELAYIUM_ACCEPTANCE_CHILD server $server_pid"

for _ in $(seq 1 100); do
  curl -sf --max-time 5 "$origin/api/config" >/dev/null 2>&1 && break
  kill -0 "$server_pid" 2>/dev/null || fail "the server exited: $(tail -5 "$run_root/server.log")"
  sleep 0.2
done
curl -sf --max-time 5 "$origin/api/config" >/dev/null 2>&1 \
  || fail "the server never became reachable"

# The observation that the run really is local, made against the SERVER rather
# than against the string this script passed around: a listener on any address
# but loopback would mean the run was reachable from the network.
listen_line="$(grep -m1 'listening on' "$run_root/server.log" || true)"
case "$listen_line" in
  *"127.0.0.1:$server_port"*) : ;;
  *) fail "the server is not listening on loopback: $listen_line" ;;
esac

# `/api/ice` must offer exactly what the app needs and nothing that leaves this
# machine. See the header for why "no servers at all" was the wrong assertion.
curl -sf --max-time 15 "$origin/api/ice" -o "$run_root/ice.json" \
  || fail "could not read /api/ice from the local server"
python3 - "$run_root/ice.json" <<'PY' || fail "/api/ice is not loopback-only STUN"
import json, sys

doc = json.load(open(sys.argv[1]))
servers = doc.get("iceServers")
problems = []

# The app's own precondition, asserted here so a server misconfiguration is
# reported as such instead of surfacing later as an opaque "the server sent a
# response this version of the app doesn't understand" on the receiving peer.
if not servers:
    problems.append(
        "iceServers is %r, but parseICEConfig (ICEClient.swift) treats an "
        "absent or empty list as a hard configuration failure, so every "
        "receiving peer would fail before it connected" % (servers,))
    servers = []

for entry in servers:
    for url in entry.get("urls", []):
        scheme = url.partition(":")[0].lower()
        if scheme not in ("stun", "stuns"):
            problems.append(
                "%s is not STUN: a local run must never be offered a relay" % url)
            continue
        rest = url.partition(":")[2].split("?")[0]
        host = rest.rsplit(":", 1)[0].strip("[]") if ":" in rest else rest.strip("[]")
        if host not in ("127.0.0.1", "::1", "localhost"):
            problems.append(
                "STUN host %s is not loopback: this run would tell a third "
                "party this machine's address" % host)
    if entry.get("username") or entry.get("credential"):
        problems.append("an iceServers entry carries relay credentials")

if doc.get("relays"):
    problems.append("a relay pool was offered: %r" % (doc["relays"],))

if problems:
    for problem in problems:
        print("  - %s" % problem, file=sys.stderr)
    sys.exit(1)

print("-- /api/ice offers %d loopback STUN entry/entries, no relay, no credential"
      % len(servers), file=sys.stderr)
PY
say "-- server is loopback-only and offers no public STUN and no TURN"

# ── an account, for the pairing half ─────────────────────────────────────────
#
# Minting a pairing code is account-attributed, so the pairing transfer needs a
# real account on this throwaway server. Created through the product's own HTTP
# API, which is the point: a fixture that inserted a row directly would prove
# nothing about the endpoints the app calls.
#
# The password never reaches argv: it is written into a request body file that
# lives inside the per-run root and is removed with it.

account_email="acceptance-${run_tag}@example.invalid"
account_password="$(od -An -tx1 -N24 /dev/urandom | tr -d ' \n')"
umask 077
printf '{"email":"%s","password":"%s"}' "$account_email" "$account_password" \
  >"$run_root/register.json"

curl -sf --max-time 20 -X POST "$origin/api/auth/register" \
  -H 'Content-Type: application/json' \
  --data-binary "@$run_root/register.json" >/dev/null \
  || fail "could not register the acceptance account"

# The server has no SMTP configured, so it logs the verification link instead of
# sending one. Reading it here is the local equivalent of the user clicking it.
#
# `grep -m1` rather than `grep | head -1`: under `set -o pipefail` the head
# closing the pipe can take grep down with SIGPIPE, which turns a working read
# into an intermittent failure.
verify_token="$(grep -o -m1 'verify-email?token=[0-9a-f]*' "$run_root/server.log" \
  | cut -d= -f2)"
[ -n "$verify_token" ] || fail "the server did not log a verification token"

# The password is confirmed IN the verification call. `VerifyEmail` drops a
# registration password that is not confirmed here, after which every later
# login is a 401 that looks like a bad credential rather than a dropped one.
printf '{"token":"%s","password":"%s"}' "$verify_token" "$account_password" \
  >"$run_root/verify.json"
curl -sf --max-time 20 -X POST "$origin/api/auth/email/verify" \
  -H 'Content-Type: application/json' \
  --data-binary "@$run_root/verify.json" >/dev/null \
  || fail "could not verify the acceptance account"

printf '{"email":"%s","password":"%s","deviceName":"acceptance-peer"}' \
  "$account_email" "$account_password" >"$run_root/login.json"
curl -sf --max-time 20 -X POST "$origin/api/auth/native/login" \
  -H 'Content-Type: application/json' \
  --data-binary "@$run_root/login.json" \
  -o "$run_root/session.json" \
  || fail "could not sign the acceptance account in"

account_token="$(python3 -c '
import json, sys
print(json.load(open(sys.argv[1])).get("token", ""))' "$run_root/session.json")"
[ -n "$account_token" ] || fail "the login answered no bearer token"
# Four bodies carried a password or a bearer token. They are removed as soon as
# they are spent rather than lingering for the length of the run — `session.json`
# included, because the run root is deliberately KEPT on failure and a retained
# bearer token is the one thing in it that should not outlive the run.
rm -f "$run_root/register.json" "$run_root/verify.json" "$run_root/login.json" \
      "$run_root/session.json"
say "-- an acceptance account exists on the local server"

# ── the peers ────────────────────────────────────────────────────────────────

control_token="$(od -An -tx1 -N32 /dev/urandom | tr -d ' \n')"
export RELAYIUM_ACCEPTANCE_CONTROL_TOKEN="$control_token"

# Extra environment for the NEXT `start_peer` only, reset after every use so a
# bearer token cannot leak into a peer that has no business holding one.
declare -a peer_env=()

# start_peer <label> <role> [extra args...]
#
# Sets the globals `peer_port` and `peer_pid`, and records both in the run's
# registries.
#
# **Never call this in a command substitution.** It was written as
# `port="$(start_peer …)"`, which runs the whole function in a SUBSHELL: the
# peer was backgrounded there, `child_pids+=(…)` mutated a copy that died with
# the subshell, and the surviving peer was reparented to PID 1 the moment the
# substitution closed. Cleanup then had nothing to kill, and three orphaned
# peers outlived three failed runs. The port comes back in a global for exactly
# that reason — a value is cheap to return, a tracked child is not.
start_peer() {
  local label="$1" role="$2"
  shift 2
  local log="$run_root/$label.log"

  if [ "${#peer_env[@]}" -gt 0 ]; then
    env "${peer_env[@]}" \
      "$peer_binary" --role "$role" --origin "$origin" --run-tag "$run_tag" "$@" \
      >"$run_root/$label.out" 2>"$log" &
  else
    "$peer_binary" --role "$role" --origin "$origin" --run-tag "$run_tag" "$@" \
      >"$run_root/$label.out" 2>"$log" &
  fi
  peer_pid=$!
  peer_env=()

  child_labels+=("$label")
  child_pids+=("$peer_pid")
  emit "RELAYIUM_ACCEPTANCE_CHILD $label $peer_pid"

  peer_port=""
  local waited=0
  while [ "$waited" -lt 150 ]; do
    peer_port="$(grep -o -m1 'RELAYIUM_PEER_READY {"port":[0-9]*' "$run_root/$label.out" 2>/dev/null \
      | grep -o '[0-9]*$' || true)"
    [ -n "$peer_port" ] && break
    kill -0 "$peer_pid" 2>/dev/null \
      || fail "$label exited before it was ready (pid $peer_pid)"
    sleep 0.2
    waited=$((waited + 1))
  done
  [ -n "$peer_port" ] \
    || fail "$label never announced a control port within 30s (pid $peer_pid)"

  peer_labels+=("$label")
  peer_ports+=("$peer_port")
  peer_pids+=("$peer_pid")
  return 0
}

# The control API is loopback-bound AND token-guarded. Both are asserted below.
control() {
  local port="$1" method="$2" path="$3" body="${4:-}"
  if [ -n "$body" ]; then
    curl -sf --max-time 15 -X "$method" "http://127.0.0.1:$port$path" \
      -H "Authorization: Bearer $control_token" \
      -H 'Content-Type: application/json' --data-binary "$body"
  else
    curl -sf --max-time 15 -X "$method" "http://127.0.0.1:$port$path" \
      -H "Authorization: Bearer $control_token"
  fi
}

json_field() {
  python3 -c '
import json, sys
try:
    print(json.loads(sys.argv[1]).get(sys.argv[2], ""))
except Exception:
    print("")' "$1" "$2"
}

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

unauthenticated_status="$(curl -s --max-time 5 -o /dev/null -w '%{http_code}' \
  "http://127.0.0.1:$receiver_port/status" || true)"
[ "$unauthenticated_status" = "401" ] \
  || fail "the control API answered an unauthenticated caller with $unauthenticated_status"
wrong_token_status="$(curl -s --max-time 5 -o /dev/null -w '%{http_code}' \
  -H "Authorization: Bearer not-the-token" \
  "http://127.0.0.1:$receiver_port/status" || true)"
[ "$wrong_token_status" = "401" ] \
  || fail "the control API accepted a wrong token with $wrong_token_status"
say "-- the control API refuses a missing and a wrong token"

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

control "$receiver_port" POST /shutdown >/dev/null || true
control "$sender_port" POST /shutdown >/dev/null || true

# ── PAIRING ──────────────────────────────────────────────────────────────────

say "== PAIRING: a real minted code, joined by a second process =="
mkdir -p "$run_root/pair-send" "$run_root/pair-receive"

start_peer pair-receiver pair-receiver --receive-root "$run_root/pair-receive"
pair_receiver_port="$peer_port"

# The account bearer reaches this peer alone, through the environment rather
# than argv, and `start_peer` clears the slot afterwards.
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

# ── the run really was local ─────────────────────────────────────────────────
#
# Asserted from the SERVER's own view: both transfers rendezvoused through this
# process, so its log is the record of whether anything happened at all. A run
# whose peers had somehow reached production would leave this empty while every
# receipt above still matched.
grep -q 'listening on 127.0.0.1' "$run_root/server.log" \
  || fail "the server never reported a loopback listener"
# An `if`, not `grep … && fail`: as the last command of a `&&` list, a grep that
# correctly finds nothing returns 1, and `set -e` would end the run — silently,
# one line before PASS — on precisely the outcome this asserts.
if grep -qi 'github' "$run_root/server.log"; then
  fail "the server made its release check, so this run was not offline"
fi

completed=1
say ""
say "PASS: Nearby and pairing transfers both completed peer-to-peer against"
say "      $origin with matching names, sizes and SHA-256 digests."
say "      No Q0 matrix cell is claimed: no built App UI path ran."
