# shellcheck shell=bash
#
# The isolation rules every local acceptance run shares, in one implementation.
#
# Extracted from `local-transfer-acceptance.sh` when `ios-ui-session-acceptance.sh`
# became its second caller. The extraction is not tidiness: every rule below is
# one that has already been got wrong somewhere in this workspace, and a rule
# that exists in two copies is a rule that will be fixed in one of them.
#
#   * Every port is ephemeral (:0 / kernel-assigned). A fixed port is how two
#     concurrent runs on one machine end up talking to each other's server.
#   * The database, the blob directory, every receive root and every log live
#     under ONE per-run temporary root, removed on the way out.
#   * Receive roots are inside that root and are passed explicitly. The product's
#     own default receive directory is the user's Downloads folder, and a run
#     that fell back to it would write real files into a real person's folder.
#   * Tokens are passed in the ENVIRONMENT and never in argv, because argv on
#     macOS is readable by every process this user runs.
#   * Cleanup kills exactly the PIDs a run started. There is no `pkill` and no
#     pattern match: a pattern that matched a developer's own editor, server or
#     debugger would be a script that ends other people's work.
#   * RELAYIUM_RELEASE_CHECK=false. The server otherwise asks api.github.com for
#     the newest release at startup, which is a real outbound request from a run
#     whose whole claim is that it makes none.
#
# ── the STUN entry, and why "no ICE at all" was wrong ────────────────────────
#
# The server is configured with ONE STUN URL pointing at loopback. Nothing
# listens on it, and nothing needs to: two peers on one machine pair on host
# candidates, and `RealtimeConnectionFactory.nearbyICEServers` filters the
# response to STUN-only anyway. What the loopback URL buys is that the app's
# fail-closed rule — `parseICEConfig` treats an absent or empty `iceServers` as
# `AccountError.decoding`, deliberately — is satisfied by a value that cannot
# leave this machine, so the run exercises the shipped path instead of a path no
# user has. Without it the receiver went straight to `.failed` with the
# account-decoding copy about a millisecond into the transfer.
#
# ── using it ─────────────────────────────────────────────────────────────────
#
#   source "$(dirname "${BASH_SOURCE[0]}")/lib/local-acceptance.sh"
#   acceptance_begin                 # run root, traps, registries
#   acceptance_build "$server_dir" "$package_dir"
#   acceptance_start_server          # $origin, and the loopback assertions
#   acceptance_create_account        # $account_token, for a run that mints
#   start_peer <label> <role> [args] # sets $peer_port and $peer_pid
#   ...
#   completed=1                      # on the LAST line, and nowhere else
#
# Nothing here runs at source time: a library that acted on being sourced would
# make the order above a suggestion rather than the thing the caller controls.

# Nothing listens here. See the header.
loopback_stun="stun:127.0.0.1:3478"

# Every process a run started, in start order, with a label for diagnosis.
# Appended to from the TOP-LEVEL shell only — see `start_peer`.
declare -a child_labels=()
declare -a child_pids=()

# The subset that speaks the loopback control API.
declare -a peer_labels=()
declare -a peer_ports=()
declare -a peer_pids=()

# Extra environment for the NEXT `start_peer` only, reset after every use so a
# bearer token cannot leak into a peer that has no business holding one.
declare -a peer_env=()

say() { printf '%s\n' "$*" >&2; }

# Take ownership of one process this run started, so cleanup and the signal
# handlers reach it by PID.
#
# Called from the TOP-LEVEL shell only. A caller that ran this inside a command
# substitution would append to a copy of the registry that dies with the
# subshell, which is the exact leak `local-transfer-cleanup-test.sh` was written
# for: three orphaned peers, and nothing in the suite noticing.
register_child() {
  child_labels+=("$1")
  child_pids+=("$2")
  emit "RELAYIUM_ACCEPTANCE_CHILD $1 $2"
}

# Machine-readable lines for the cleanup test (and for a human reading a failed
# run): every child a run owns is announced as it starts, so an external
# observer can prove afterwards that none of them survived.
emit() { printf '%s\n' "$*" >&2; }

# Set to 1 on the last line of a run, and nowhere else.
#
# It exists because a signal does NOT reliably reach the handlers below. Bash
# does not run a trapped INT while it is waiting on a foreground child: the
# measured behaviour is that the shell exits, the INT trap never fires, and — if
# no command had failed yet — it exits 0. An interrupted acceptance run that
# reported success would be the worst failure mode these scripts have, so the
# EXIT trap refuses a zero status that did not come from reaching the end.
completed=0

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
  # PIDs this run recorded.
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
  # starting them at the top level — so `wait` actually collects them instead of
  # leaving zombies behind.
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

# A hook a caller sets when it owns something this library does not — the iOS
# run's booted simulator, for instance. Called once, before the children are
# terminated, and never allowed to fail the cleanup it runs inside.
acceptance_extra_cleanup() { :; }

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
      # The live link view, for the roles that have one. A 409 means the role
      # has none, which is not a failure and is printed as it comes.
      status="$(curl -sf --max-time 5 -H "Authorization: Bearer ${control_token:-}" \
        "http://127.0.0.1:$port/observed" 2>/dev/null || true)"
      [ -n "$status" ] && say "   observed: $status"
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

cleanup() {
  local status=$?
  trap - EXIT INT TERM HUP
  if [ "$status" -eq 0 ] && [ "$completed" -ne 1 ]; then
    say "-- the run ended before reaching its PASS line, so it was interrupted"
    say "   or abandoned; reporting failure rather than an unearned success"
    status=1
  fi
  acceptance_extra_cleanup || true
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
  acceptance_extra_cleanup || true
  terminate_children
  [ -d "$run_root" ] && say "--- run root kept for diagnosis: $run_root"
  # Re-raise so whoever signalled us observes a real signal death rather than an
  # ordinary exit status.
  kill -"$sig" $$
}

# ── fault injection, for the cleanup test only ───────────────────────────────
#
# RELAYIUM_ACCEPTANCE_FAULT names a stage at which a run must fail, or
# `hold:<stage>` to park there until something signals it. Both exist so
# `local-transfer-cleanup-test.sh` can drive the failure and interrupt paths with
# real children running.
#
# It can only ever make a run FAIL. There is no value that skips an assertion,
# shortens a wait or fabricates a receipt, so a stray setting in a real run turns
# into a loud failure rather than a false pass.
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

# ── the phases ───────────────────────────────────────────────────────────────

# The per-run root, the registries and the traps. Call first.
acceptance_begin() {
  run_tag="$(od -An -tx1 -N4 /dev/urandom | tr -d ' \n')"
  run_root="$(mktemp -d "${TMPDIR:-/tmp}/relayium-acceptance-${run_tag}.XXXXXX")"

  emit "RELAYIUM_ACCEPTANCE_RUN_TAG $run_tag"
  emit "RELAYIUM_ACCEPTANCE_RUN_ROOT $run_root"

  trap cleanup EXIT
  trap 'on_signal INT' INT
  trap 'on_signal TERM' TERM
  trap 'on_signal HUP' HUP
}

# acceptance_build <server source dir> <SwiftPM package dir>
#
# The server and the acceptance peer, built into the run root. Both directories
# are ARGUMENTS rather than globals the caller is expected to have set: a library
# that read a variable a caller happened to name the same way is a library whose
# contract is a convention, and the failure when the convention drifts is a build
# of the wrong tree.
acceptance_build() {
  local server_dir="$1" package_dir="$2"
  say "== building the local server and the acceptance peer =="
  ( cd "$server_dir" && go build -o "$run_root/relayium-server" . )
  ( cd "$package_dir" && swift build --product LocalTransferPeer >/dev/null )
  peer_binary="$(cd "$package_dir" && swift build --product LocalTransferPeer --show-bin-path)/LocalTransferPeer"
  [ -x "$peer_binary" ] || fail "the acceptance peer did not build"
}

# A throwaway server on an ephemeral loopback port, with every assertion that
# makes "this run is local" an observation rather than a claim.
acceptance_start_server() {
  server_port="$(free_port)"
  origin="http://127.0.0.1:$server_port"
  mkdir -p "$run_root/blobs"

  say "== starting a throwaway server on $origin =="
  # The built Web bundle, for a run whose second endpoint is a real browser.
  # Default empty rather than the binary's own `../web/dist`: a run that did not
  # ask for the site must not end up serving whatever happens to be in the
  # developer's checkout, and one that DID must fail loudly if it is missing
  # rather than 404 halfway through.
  local static_dir="${acceptance_server_static:-$run_root/no-static}"
  mkdir -p "$run_root/no-static"
  RELAYIUM_RELEASE_CHECK=false \
    "$run_root/relayium-server" \
    -addr "127.0.0.1:$server_port" \
    -db "$run_root/relayium.db" \
    -blob-dir "$run_root/blobs" \
    -static "$static_dir" \
    -stun-urls "$loopback_stun" \
    >"$run_root/server.log" 2>&1 &
  server_pid=$!
  register_child server "$server_pid"

  local _
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
  local listen_line
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

  # The control bearer every peer this run starts will require. Exported rather
  # than passed, because argv on macOS is readable by every process this user
  # runs.
  control_token="$(od -An -tx1 -N32 /dev/urandom | tr -d ' \n')"
  export RELAYIUM_ACCEPTANCE_CONTROL_TOKEN="$control_token"
}

# An account on the throwaway server, for a run that mints a pairing code.
#
# Created through the product's own HTTP API, which is the point: a fixture that
# inserted a row directly would prove nothing about the endpoints the app calls.
# The password never reaches argv — it is written into a request body file inside
# the per-run root and removed as soon as it is spent.
#
# **Set `acceptance_extra_devices` before calling to get extra device rows.**
# A Device Inbox run needs several device ROWS on one account — a delivery is
# sealed to one device's key and a sender is removed from its own target list —
# and a row is what `native/login` mints per `deviceName`. They are logged in
# HERE rather than by the caller for one reason: the password stays `local` to
# this function. A caller that could log in for itself would need the password
# to outlive the request bodies below, which is the one secret in a run root
# that must not.
#
# A pre-set array rather than positional arguments, so the three existing
# callers keep calling this with no arguments and stay free of ShellCheck's
# SC2119 — a signature change that made every current call site warn would be a
# cost paid by scripts that do not use the feature.
#
# Sets `account_device_tokens` and `account_device_names`, index-aligned.
acceptance_create_account() {
  local -a extra_devices=(${acceptance_extra_devices+"${acceptance_extra_devices[@]}"})
  account_email="acceptance-${run_tag}@example.invalid"
  local account_password
  account_password="$(od -An -tx1 -N24 /dev/urandom | tr -d ' \n')"
  umask 077
  printf '{"email":"%s","password":"%s"}' "$account_email" "$account_password" \
    >"$run_root/register.json"

  curl -sf --max-time 20 -X POST "$origin/api/auth/register" \
    -H 'Content-Type: application/json' \
    --data-binary "@$run_root/register.json" >/dev/null \
    || fail "could not register the acceptance account"

  # The server has no SMTP configured, so it logs the verification link instead
  # of sending one. Reading it here is the local equivalent of the user clicking
  # it.
  #
  # `grep -m1` rather than `grep | head -1`: under `set -o pipefail` the head
  # closing the pipe can take grep down with SIGPIPE, which turns a working read
  # into an intermittent failure.
  local verify_token
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

  # One more login per requested device name, each of which mints its OWN device
  # row. Same endpoint, same body shape, same immediate removal of the file that
  # carried the password.
  account_device_names=()
  account_device_tokens=()
  local device body token
  for device in ${extra_devices+"${extra_devices[@]}"}; do
    body="$run_root/login-device.json"
    printf '{"email":"%s","password":"%s","deviceName":"%s"}' \
      "$account_email" "$account_password" "$device" >"$body"
    curl -sf --max-time 20 -X POST "$origin/api/auth/native/login" \
      -H 'Content-Type: application/json' \
      --data-binary "@$body" -o "$run_root/device-session.json" \
      || fail "could not sign in the acceptance device $device"
    rm -f "$body"
    token="$(python3 -c '
import json, sys
print(json.load(open(sys.argv[1])).get("token", ""))' "$run_root/device-session.json")"
    rm -f "$run_root/device-session.json"
    [ -n "$token" ] || fail "the login for $device answered no bearer token"
    account_device_names+=("$device")
    account_device_tokens+=("$token")
  done
  # Four bodies carried a password or a bearer token. They are removed as soon as
  # they are spent rather than lingering for the length of the run —
  # `session.json` included, because the run root is deliberately KEPT on failure
  # and a retained bearer token is the one thing in it that should not outlive
  # the run.
  rm -f "$run_root/register.json" "$run_root/verify.json" "$run_root/login.json" \
        "$run_root/session.json"
  say "-- an acceptance account exists on the local server"
}

# start_peer <label> <role> [extra args...]
#
# Sets the globals `peer_port` and `peer_pid`, and records both in the run's
# registries.
#
# **Never call this in a command substitution.** It was written as
# `port="$(start_peer …)"`, which runs the whole function in a SUBSHELL: the peer
# was backgrounded there, `child_pids+=(…)` mutated a copy that died with the
# subshell, and the surviving peer was reparented to PID 1 the moment the
# substitution closed. Cleanup then had nothing to kill, and three orphaned peers
# outlived three failed runs. The port comes back in a global for exactly that
# reason — a value is cheap to return, a tracked child is not.
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

  register_child "$label" "$peer_pid"

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

# The control API is loopback-bound AND token-guarded. Both are asserted by the
# callers that reach a peer first.
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

# The two refusals every run makes against the FIRST peer it starts, so a control
# API that stopped guarding itself fails a run rather than going unnoticed.
assert_control_api_is_guarded() {
  local port="$1" status
  status="$(curl -s --max-time 5 -o /dev/null -w '%{http_code}' \
    "http://127.0.0.1:$port/status" || true)"
  [ "$status" = "401" ] \
    || fail "the control API answered an unauthenticated caller with $status"
  status="$(curl -s --max-time 5 -o /dev/null -w '%{http_code}' \
    -H "Authorization: Bearer not-the-token" \
    "http://127.0.0.1:$port/status" || true)"
  [ "$status" = "401" ] \
    || fail "the control API accepted a wrong token with $status"
  say "-- the control API refuses a missing and a wrong token"
}

# Asserted from the SERVER's own view: every transfer rendezvoused through this
# process, so its log is the record of whether anything happened at all. A run
# whose peers had somehow reached production would leave this empty while every
# receipt still matched.
assert_run_was_local() {
  grep -q 'listening on 127.0.0.1' "$run_root/server.log" \
    || fail "the server never reported a loopback listener"
  # An `if`, not `grep … && fail`: as the last command of a `&&` list, a grep
  # that correctly finds nothing returns 1, and `set -e` would end the run —
  # silently, one line before PASS — on precisely the outcome this asserts.
  if grep -qi 'github' "$run_root/server.log"; then
    fail "the server made its release check, so this run was not offline"
  fi
}
