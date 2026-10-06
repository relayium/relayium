#!/usr/bin/env bash
#
# **A12: the real `relayium pair` CLI ↔ a real browser, over a real code, on a
# real server.**
#
#   ./scripts/interop/cli-web-acceptance.sh
#
# The cell no Go test can fill: `server/cmd/relayium/pair_test.go` runs the CLI
# against another CLI and against Go-authored "app" doubles, and every Web e2e
# peer is a browser. Neither can see a DISAGREEMENT between the two independent
# link/1 implementations — Pion + linksession on one side, the shipped bundle on
# the other — which is exactly the class of defect a cross-client matrix exists
# for. So there is no double on either side here:
#
#   * a real Relayium server built from ./server on an ephemeral loopback port,
#     serving the real built Web bundle, loopback STUN only, no TURN;
#   * a disposable account created through the product's own HTTP API;
#   * the CLI binary built from ./server/cmd/relayium, `relayium pair`, stdin a
#     pipe, its bearer only in a private credentials file;
#   * one headless Chrome on the real bundle, joined to the same code.
#
# ## What one round proves (web/e2e/cli-web-pairing.mjs has the sequence)
#
# text both ways; web→cli a flat multi-file batch and then a folder batch
# (two consecutive batches, exact tree on disk); cli→web flat files and then a
# directory tree (exact paths and bytes in the page's save ledger); a decline
# in each direction; a cancel by the sending page and a stop by the receiving
# page, each with a body larger than one flow window; text again after both;
# and the end of the session — `/quit`, or SIGINT mid-transfer.
#
# ## Which rounds
#
# Exactly four, unconditionally — no round override, no early exit, no random
# fallback. The CODE role is who mints: the CLI (`relayium pair`) or the page
# (signed in, "create code"). The LINK role follows from the two code-room
# ids (`linkwire.LinkRole`: the smaller id initiates), and the run's loopback
# acceptance server assigns those ids from a fixed schedule
# (`RELAYIUM_ACCEPTANCE_PEER_IDS`, guarded to a loopback listener; production
# keeps random ids), one per ACCEPTED websocket in order. So the four
# (code role × link role) cells are each played once, by schedule:
#
#   round  minted by  CLI role   SAS      ending     sockets (seq)
#   1      CLI        responder  on       /quit      CLI 1, page 2
#   2      CLI        initiator  default  /quit      CLI 3, page 4
#   3      page       responder  on       interrupt  page LAN 5, page LAN 6,
#                                                     page code room 7, CLI 8
#   4      page       initiator  default  /quit      page LAN 9, page LAN 10,
#                                                     page code room 11, CLI 12
#
# A page-minted round's page opens THREE sockets: the app's mount socket on
# `/` (a LAN room), another on `/cross-network`, and the code room "create
# code" rebinds it to. Each is scheduled its own id. The driver
# (`web/e2e/cli-web-pairing.mjs`) owns both actors, so it owns every barrier:
# no socket is opened until the previous one is welcomed (for the page) as
# its planned id and the server's log shows exactly sequences 1..seq
# accepted, with every actor started so far still alive. After each round,
# with the CLI reaped and Chrome observed to exit, the server must have
# accepted exactly the prefix 2/6/8/12; at the end it is stopped and all
# twelve are counted once more. An extra, refused or reconnected socket is a
# FAILURE in the round that caused it, never a retry or a new round.
#
# ## Pacing
#
# Every socket is also one request against a production 5/min per-IP cap
# from this one loopback address (`/api/ice`, which counts LAN requests too;
# the code-bearing `/ws` joins are a subset). The budget is paced, never
# relaxed: `cli-matrix-plan.py web-budget` reads each round's declared socket
# count and says which rounds must first wait out the window (65 s, after
# the previous round's clients are gone). The two CLI-minted rounds run
# first because together they open four sockets, which fit one window; each
# page-minted round's four then needs a window of its own. Two waits, where
# the former alternating order (2, 4, 2, 4 sockets) needed three.
#
# ## Evidence level
#
# LOOPBACK: one machine, host candidates, no NAT, no relay. It is not NAT-lab
# or real-WAN evidence (release-time C01/C07) and says nothing about TURN.
set -Eeuo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$here/../.." && pwd)"
# shellcheck source-path=SCRIPTDIR
# shellcheck source=../lib/local-acceptance.sh
source "$here/../lib/local-acceptance.sh"

# The schedule. Twelve ids, distinct across the whole list (and from every
# other lane's); `scripts/test/role-coverage-cap-test.mjs` holds these
# declarations to that shape and to the cells above. Each round's sockets are
# `round_prefix_ends[r-2]+1 .. round_prefix_ends[r-1]`, in the order the
# driver opens them; `cli-matrix-plan.py web` refuses a range that is not the
# code role's socket count or ids that do not imply the planned role.
max_rounds=4
acceptance_peer_ids="e777777777777777,0777777777777777,0999999999999999,e999999999999999,a888888888888888,b888888888888888,0888888888888888,e888888888888888,abababababababab,bcbcbcbcbcbcbcbc,eaeaeaeaeaeaeaea,0aaaaaaaaaaaaaaa"
round_code_roles=(cli cli web web)
planned_roles=(responder initiator responder initiator)
round_verify=(on default on default)
round_endings=(quit quit interrupt quit)
round_prefix_ends=(2 4 8 12)

# Wait out the server's per-IP budget before ROUND exactly when the pacing
# plan (`round_budget_waits`, from `cli-matrix-plan.py web-budget`) says so.
# Anything but `go` or `wait` fails: a round is never run unpaced by default.
pace_join_budget() {
  local decision="${round_budget_waits[$(($1 - 1))]:-}"
  case "$decision" in
    wait)
      say "-- waiting out the server's per-IP join budget before round $1"
      sleep 65
      ;;
    go) say "-- round $1's sockets fit the current join-budget window" ;;
    *) fail "the pacing plan has no decision for round $1" ;;
  esac
}

# Is this owned child still running? `kill -0` also answers yes for an exited,
# unreaped process, so the process state is read.
owned_child_running() {
  local state
  state="$(ps -o stat= -p "$1" 2>/dev/null || true)"
  state="${state#"${state%%[![:space:]]*}"}"
  [ -n "$state" ] && [ "${state#Z}" = "$state" ]
}

# Blank exactly the one cleanup-registry slot whose label AND pid match; fail
# on zero or several — the cleanup trap must never signal a reaped PID.
retire_owned_child() {
  local label="$1" pid="$2" i matched=0
  for i in "${!child_pids[@]}"; do
    if [ "${child_pids[$i]}" = "$pid" ] && [ "${child_labels[$i]}" = "$label" ]; then
      child_pids[i]=""
      matched=$((matched + 1))
    fi
  done
  [ "$matched" -eq 1 ] || fail "the exited $label (pid $pid) matched $matched registry slots, not one"
}

# Stop THIS run's server before the final count, so nothing can append to its
# log after it has been read: TERM, a bounded wait for the process to actually
# exit, a reap, and then its ONE registry slot retired.
stop_owned_server() {
  local pid="${server_pid:-}" waited=0
  [ -n "$pid" ] || fail "no owned server PID to stop before the final count"
  owned_child_running "$pid" \
    || fail "the owned server (pid $pid) was not running before the final count: $(tail -5 "$run_root/server.log")"
  kill -TERM "$pid" 2>/dev/null || fail "could not signal the owned server (pid $pid)"
  while owned_child_running "$pid"; do
    [ "$waited" -lt 100 ] || fail "the owned server (pid $pid) did not exit within 10s of SIGTERM"
    sleep 0.1
    waited=$((waited + 1))
  done
  # Its exit status under TERM is not judged; its log is.
  wait "$pid" 2>/dev/null || true
  retire_owned_child server "$pid"
  say "-- stopped this run's server (pid $pid) before the final count"
}

acceptance_begin

say "== building the local server and the CLI under test =="
( cd "$repo/server" && go build -o "$run_root/relayium-server" . ) \
  || fail "the local server failed to build"
( cd "$repo/server" && go build -o "$run_root/relayium" ./cmd/relayium ) \
  || fail "the CLI failed to build"
cli_bin="$run_root/relayium"
"$cli_bin" pair --help 2>&1 | grep -q 'relayium pair' \
  || fail "the built CLI has no \`pair\` command"

say "== building the Web bundle =="
# `vite build`, not `npm run build`: the latter regenerates committed pages
# under web/public (see native-web-pairing-acceptance.sh).
(cd "$repo/web" && npx vite build >"$run_root/web-build.log" 2>&1) \
  || fail "the Web bundle failed to build: $(tail -20 "$run_root/web-build.log")"
[ -f "$repo/web/dist/index.html" ] || fail "web/dist/index.html is missing after the build"
acceptance_server_static="$repo/web/dist"

# **The server's public base URL must be this run's own origin.** The account
# API's CSRF guard rejects a browser POST whose Origin is not the configured
# base URL (`account.CSRFGuard`), and the library starts the server on the
# default `http://localhost:8080` — correct for every native caller, which
# sends no Origin, and a 403 for the page signing in here. So the port is
# chosen first, the base URL follows it through the server's own
# `RELAYIUM_BASE_URL`, and the library's `free_port` hands out exactly that
# port once. Nothing about the guard is relaxed: the page is same-origin.
pinned_port="$(free_port)"
eval "$(declare -f free_port | sed '1s/^free_port/lib_free_port/')"
free_port() { printf '%s\n' "$pinned_port"; }
export RELAYIUM_BASE_URL="http://127.0.0.1:$pinned_port"
acceptance_start_server
eval "$(declare -f lib_free_port | sed '1s/^lib_free_port/free_port/')"
[ "$origin" = "$RELAYIUM_BASE_URL" ] || fail "the server origin $origin is not the pinned base URL $RELAYIUM_BASE_URL"
# The page mints in half the rounds, which needs a real sign-in; see
# `acceptance_create_account` for the bounds of this exception.
acceptance_publish_password=1
acceptance_create_account

curl -sf --max-time 10 "$origin/cross-network" | grep -q '<div id="app"' \
  || fail "the server is not serving the built Web app at $origin/cross-network"

# The CLI's credentials: its own file, in a private XDG_CONFIG_HOME, exactly
# the shape `relayium login` writes. Never argv, never the developer's home.
umask 077
xdg="$run_root/xdg"
mkdir -p "$xdg/relayium"
ACCOUNT_TOKEN="$account_token" python3 - "$xdg/relayium/credentials" "$origin" "$account_email" <<'PY'
import json, os, sys
path, server, email = sys.argv[1:4]
fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
with os.fdopen(fd, "w") as f:
    json.dump({"server": server, "access_token": os.environ["ACCOUNT_TOKEN"],
               "account_email": email}, f)
PY
say "-- the CLI holds a bearer for $origin in a private config dir"

# (code role × CLI link role) cells, as four plain flags: macOS still ships
# bash 3.2, which has no associative arrays.
seen_cli_initiator=0
seen_cli_responder=0
seen_web_initiator=0
seen_web_responder=0
seen_quit=0
seen_interrupt=0
round=0

# One `go`/`wait` per round, from the rounds' declared socket counts.
budget_plan="$(python3 "$here/cli-matrix-plan.py" web-budget "${round_code_roles[@]}")" \
  || fail "the rounds cannot be paced within the server's per-IP join budget"
read -r -a round_budget_waits <<<"$budget_plan"
[ "${#round_budget_waits[@]}" -eq "$max_rounds" ] \
  || fail "the pacing plan has ${#round_budget_waits[@]} decisions, not one per round"

while [ "$round" -lt "$max_rounds" ]; do
  round=$((round + 1))
  pace_join_budget "$round"

  code_role="${round_code_roles[$((round - 1))]:-}"
  planned_role="${planned_roles[$((round - 1))]:-}"
  verify="${round_verify[$((round - 1))]:-}"
  ending="${round_endings[$((round - 1))]:-}"
  end_seq="${round_prefix_ends[$((round - 1))]:-}"
  first_seq=1
  [ "$round" -eq 1 ] || first_seq=$(( ${round_prefix_ends[$((round - 2))]} + 1 ))
  [ -n "$code_role" ] && [ -n "$planned_role" ] && [ -n "$verify" ] && [ -n "$ending" ] && [ -n "$end_seq" ] \
    || fail "the schedule has no plan for round $round"

  say ""
  say "== round $round: code minted by the ${code_role}, CLI planned $planned_role, verify=$verify, ending=$ending =="
  say "-- planned sockets $first_seq..$end_seq of the schedule"

  plan="$run_root/plan-$round.json"
  obs="$run_root/observed-$round.json"
  python3 "$here/cli-matrix-plan.py" web "$run_root" "$round" "$code_role" "$verify" "$ending" \
      "$acceptance_peer_ids" "$first_seq" "$end_seq" "$planned_role" >"$plan" \
    || fail "could not build round $round's plan"

  peer_email=""
  peer_password=""
  if [ "$code_role" = web ]; then
    peer_email="$account_email"
    # shellcheck disable=SC2154 # published by acceptance_create_account
    peer_password="$account_password"
  fi
  (
    cd "$repo/web" && RELAYIUM_ACCEPTANCE_EMAIL="$peer_email" RELAYIUM_ACCEPTANCE_PASSWORD="$peer_password" \
      exec node e2e/cli-web-pairing.mjs --origin "$origin" --cli "$cli_bin" --xdg "$xdg" \
        --plan "$plan" --out "$obs" --server-log "$run_root/server.log"
  ) >"$run_root/driver-$round.log" 2>&1 &
  driver_pid=$!
  register_child "driver-$round" "$driver_pid"
  driver_status=0
  wait "$driver_pid" || driver_status=$?
  retire_owned_child "driver-$round" "$driver_pid"
  [ "$driver_status" -eq 0 ] \
    || fail "round $round's driver failed (exit $driver_status): $(tail -60 "$run_root/driver-$round.log")"
  sed 's/^/   /' "$run_root/driver-$round.log" >&2

  # The oracle prints ONE line on success: the CLI's own statement of its link
  # role, which it has already checked against the page's and the plan's.
  cli_role="$(python3 "$here/cli-web-oracle.py" "$plan" "$obs")" \
    || fail "round $round did not agree"
  case "$code_role:$cli_role" in
    cli:initiator) seen_cli_initiator=1 ;;
    cli:responder) seen_cli_responder=1 ;;
    web:initiator) seen_web_initiator=1 ;;
    web:responder) seen_web_responder=1 ;;
    *) fail "the oracle named no link role: '$cli_role'" ;;
  esac
  [ "$cli_role" = "$planned_role" ] \
    || fail "round $round: the CLI was $cli_role, but the schedule planned $planned_role"
  if [ "$ending" = quit ]; then seen_quit=1; else seen_interrupt=1; fi
  # The round's accounting, with every client it started gone: the driver
  # reaped the CLI and saw Chrome exit (the oracle required both). Exactly
  # sockets 1..end_seq, so a reconnect or an extra socket fails THIS round.
  python3 "$here/cli-web-oracle.py" accepted-prefix "$run_root/server.log" \
      "$acceptance_peer_ids" "$end_seq" \
    || fail "after round $round the server had not accepted exactly the scheduled sockets 1..$end_seq"
  say "-- round $round passed (code by $code_role, CLI was $cli_role, as planned; ending $ending)"
done

# All four rounds, never fewer: each is a cell as well as a scenario.
[ "$round" -eq 4 ] || fail "ran $round rounds, not the scheduled four"
[ "$seen_cli_initiator" = 1 ] || fail "never observed code-by-cli with the CLI as initiator; that cell is unproved"
[ "$seen_cli_responder" = 1 ] || fail "never observed code-by-cli with the CLI as responder; that cell is unproved"
[ "$seen_web_initiator" = 1 ] || fail "never observed code-by-web with the CLI as initiator; that cell is unproved"
[ "$seen_web_responder" = 1 ] || fail "never observed code-by-web with the CLI as responder; that cell is unproved"
[ "$seen_quit" = 1 ] || fail "no round ended with /quit"
[ "$seen_interrupt" = 1 ] || fail "no round ended with an interrupt mid-transfer"

# ── every accepted websocket, counted ────────────────────────────────────
#
# Only once every owned client is gone (each round's driver reaped its CLI and
# saw Chrome exit). Then the server itself is stopped and reaped, so the log
# read is COMPLETE — exactly twelve, one id each, by this lane's own oracle.
# Read before `completed=1`: on success the run root, log included, is deleted
# by the cleanup trap.
stop_owned_server
python3 "$here/cli-web-oracle.py" peer-id-log "$run_root/server.log" "$acceptance_peer_ids" \
  || fail "the server did not accept exactly the scheduled websockets"
assert_run_was_local

say ""
say "== CLI ↔ real browser (Chromium): both code roles × both link roles by schedule, text, files, folders,"
say "   consecutive batches, a decline and a cancel in each direction, /quit and ctrl-C — LOOPBACK evidence =="
completed=1
