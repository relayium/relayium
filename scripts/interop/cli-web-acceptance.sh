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
# The CODE role alternates: the CLI mints (`relayium pair`) or the page mints
# (signed in, "create code"). The LINK role is the hub's coin flip. Rounds run
# until every (code role × link role) cell has been seen AND both endings have
# been seen, and the run FAILS if its bound runs out first — half a role space
# reported as the whole of it is the failure mode this refuses.
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

# Bound on rounds. Code roles are scheduled to fill the missing cells first, so
# each code role gets about half; a role whose two link assignments have not
# both appeared in 7 of its own coin flips has a 2^-6 chance. Extra rounds are
# free on a run that would pass: the loop stops as soon as every cell is seen.
max_rounds="${RELAYIUM_CLI_WEB_ROUNDS:-14}"

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
cli_rounds=0
web_rounds=0
round=0

all_seen() {
  [ "$seen_cli_initiator$seen_cli_responder$seen_web_initiator$seen_web_responder" = 1111 ] \
    && [ "$seen_quit" = 1 ] && [ "$seen_interrupt" = 1 ]
}

# Fill the missing cells first. A code role with both link roles seen yields
# its turn to the other; otherwise alternate.
next_code_role() {
  local cli_done=0 web_done=0
  [ "$seen_cli_initiator$seen_cli_responder" = 11 ] && cli_done=1
  [ "$seen_web_initiator$seen_web_responder" = 11 ] && web_done=1
  if [ "$cli_done" = 1 ] && [ "$web_done" = 0 ]; then echo web; return; fi
  if [ "$web_done" = 1 ] && [ "$cli_done" = 0 ]; then echo cli; return; fi
  if [ "$cli_rounds" = 0 ] && [ "$web_rounds" = 0 ]; then
    # Which code role opens the run; diagnosis only, every cell is still owed.
    case "${RELAYIUM_CLI_WEB_FIRST:-cli}" in web) echo web ;; *) echo cli ;; esac
    return
  fi
  if [ "$cli_rounds" -le "$web_rounds" ]; then echo cli; else echo web; fi
}

while [ "$round" -lt "$max_rounds" ]; do
  round=$((round + 1))
  if [ "$round" -gt 1 ]; then
    # Two `/ws?code=` joins per round from this one loopback address, against
    # the server's production per-IP budget (5/min). Paced, never relaxed.
    say "-- waiting out the server's per-IP join budget before round $round"
    sleep 65
  fi

  code_role="$(next_code_role)"
  if [ "$code_role" = cli ]; then cli_rounds=$((cli_rounds + 1)); else web_rounds=$((web_rounds + 1)); fi
  # The page shows the SAS only under advanced verification, so the first
  # round of each code role turns it on (the two SAS are compared) and the rest
  # run the shipped default.
  verify=default
  if { [ "$code_role" = cli ] && [ "$cli_rounds" = 1 ]; } || { [ "$code_role" = web ] && [ "$web_rounds" = 1 ]; }; then
    verify=on
  fi
  ending=quit
  if [ "$seen_quit" = 1 ] && [ "$seen_interrupt" = 0 ]; then ending=interrupt; fi
  [ $((round % 2)) -eq 0 ] && [ "$seen_interrupt" = 0 ] && ending=interrupt

  say ""
  say "== round $round: code minted by the ${code_role}, verify=$verify, ending=$ending =="

  plan="$run_root/plan-$round.json"
  obs="$run_root/observed-$round.json"
  python3 "$here/cli-matrix-plan.py" web "$run_root" "$round" "$code_role" "$verify" "$ending" >"$plan" \
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
        --plan "$plan" --out "$obs"
  ) >"$run_root/driver-$round.log" 2>&1 &
  driver_pid=$!
  register_child "driver-$round" "$driver_pid"
  if ! wait "$driver_pid"; then
    fail "round $round's driver failed: $(tail -60 "$run_root/driver-$round.log")"
  fi
  sed 's/^/   /' "$run_root/driver-$round.log" >&2

  # The oracle prints ONE line on success: the CLI's own statement of its link
  # role, which it has already checked against the page's.
  cli_role="$(python3 "$here/cli-web-oracle.py" "$plan" "$obs")" \
    || fail "round $round did not agree"
  case "$code_role:$cli_role" in
    cli:initiator) seen_cli_initiator=1 ;;
    cli:responder) seen_cli_responder=1 ;;
    web:initiator) seen_web_initiator=1 ;;
    web:responder) seen_web_responder=1 ;;
    *) fail "the oracle named no link role: '$cli_role'" ;;
  esac
  if [ "$ending" = quit ]; then seen_quit=1; else seen_interrupt=1; fi
  say "-- round $round passed (code by $code_role, CLI was $cli_role, ending $ending)"

  all_seen && break
done

[ "$seen_cli_initiator" = 1 ] || fail "never observed code-by-cli with the CLI as initiator in $round rounds; that cell is unproved"
[ "$seen_cli_responder" = 1 ] || fail "never observed code-by-cli with the CLI as responder in $round rounds; that cell is unproved"
[ "$seen_web_initiator" = 1 ] || fail "never observed code-by-web with the CLI as initiator in $round rounds; that cell is unproved"
[ "$seen_web_responder" = 1 ] || fail "never observed code-by-web with the CLI as responder in $round rounds; that cell is unproved"
[ "$seen_quit" = 1 ] || fail "no round ended with /quit"
[ "$seen_interrupt" = 1 ] || fail "no round ended with an interrupt mid-transfer"

assert_run_was_local

say ""
say "== CLI ↔ real browser (Chromium): both code roles × both link roles, text, files, folders,"
say "   consecutive batches, a decline and a cancel in each direction, /quit and ctrl-C — LOOPBACK evidence =="
completed=1
