#!/usr/bin/env bash
#
# **A12: the real `relayium pair` CLI ↔ the macOS app's own link workspace, over
# a real code, on a real server.**
#
#   ./scripts/interop/cli-mac-acceptance.sh
#
# macOS only: the Apple half is `LocalTransferPeer --role pair-link`, the app's
# `LinkWorkspaceModel` assembled by `AppEnvironment` exactly as `RelayiumApp`
# assembles it (the same peer `native-web-pairing-acceptance.sh` puts against a
# browser). The CLI half is `scripts/interop/cli-mac-peer.mjs` driving a real
# `relayium pair --accept`.
#
# Cells, each required: the code minted by the Mac (the CLI joins) and by the
# CLI (the Mac joins); the CLI as link initiator and as responder; per round,
# text both ways, two consecutive Mac→CLI batches, and a flat CLI→Mac batch
# followed by a directory tree, every byte compared.
#
# NOT covered here, by the peer's control surface rather than by choice: the Mac
# auto-accepts and cannot be told to decline or cancel. Those cells are proved
# against the browser and the Android app. iOS shares this package's link
# workspace but is not run here (no simulator in this lane).
#
# Evidence level: LOOPBACK, macOS app MODEL-to-process (the production models,
# headless, not the signed app bundle — signed-app runs are release-time C07).
set -Eeuo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$here/../.." && pwd)"
# shellcheck source-path=SCRIPTDIR
# shellcheck source=../lib/local-acceptance.sh
source "$here/../lib/local-acceptance.sh"

# Both link roles have to appear across the rounds (P(miss) = 2^-(N-1)); the
# bound also has to fit the `pairing` job's 60-minute ceiling behind the
# browser acceptance, so it is 8, not 10.
max_rounds="${RELAYIUM_CLI_MAC_ROUNDS:-8}"

acceptance_begin
acceptance_build "$repo/server" "$repo/apps/RelayiumKit"
( cd "$repo/server" && go build -o "$run_root/relayium" ./cmd/relayium ) || fail "the CLI failed to build"
cli_bin="$run_root/relayium"

acceptance_start_server
acceptance_create_account

umask 077
xdg="$run_root/xdg"
mkdir -p "$xdg/relayium"
ACCOUNT_TOKEN="$account_token" python3 - "$xdg/relayium/credentials" "$origin" "$account_email" <<'PY'
import json, os, sys
path, server, email = sys.argv[1:4]
fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
with os.fdopen(fd, "w") as f:
    json.dump({"server": server, "access_token": os.environ["ACCOUNT_TOKEN"], "account_email": email}, f)
PY

seen_initiator=0; seen_responder=0; seen_mac=0; seen_cli=0
round=0
while [ "$round" -lt "$max_rounds" ]; do
  round=$((round + 1))
  if [ "$round" -gt 1 ]; then
    say "-- waiting out the server's per-IP join budget before round $round"
    sleep 65
  fi
  if [ $((round % 2)) -eq 1 ]; then code_role=mac; else code_role=cli; fi
  say ""
  say "== round $round: code minted by the $code_role =="

  plan="$run_root/plan-$round.json"
  python3 "$here/cli-matrix-plan.py" mac "$run_root" "$round" "$code_role" >"$plan" \
    || fail "could not build round $round's plan"

  peer_env=("RELAYIUM_ACCEPTANCE_ACCOUNT_TOKEN=$account_token")
  # The receive root the oracle will read off disk is the plan's, not a second
  # spelling of it here.
  mac_receive="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["macReceive"])' "$plan")"
  start_peer "mac-$round" pair-link --receive-root "$mac_receive"
  mac_port="$peer_port"
  [ "$round" -eq 1 ] && assert_control_api_is_guarded "$mac_port"

  obs="$run_root/observed-$round.json"
  node "$here/cli-mac-peer.mjs" --plan "$plan" --out "$obs" --cli "$cli_bin" --xdg "$xdg" \
    --origin "$origin" --mac-port "$mac_port" >"$run_root/driver-$round.log" 2>&1 &
  driver_pid=$!
  register_child "driver-$round" "$driver_pid"
  wait "$driver_pid" || fail "round $round's driver failed: $(tail -60 "$run_root/driver-$round.log")"
  sed 's/^/   /' "$run_root/driver-$round.log" >&2

  role="$(python3 "$here/cli-mac-oracle.py" "$plan" "$obs")" || fail "round $round did not agree"
  case "$role" in
    initiator) seen_initiator=1 ;;
    responder) seen_responder=1 ;;
    *) fail "the oracle named no role: '$role'" ;;
  esac
  [ "$code_role" = mac ] && seen_mac=1
  [ "$code_role" = cli ] && seen_cli=1
  control "$mac_port" POST /shutdown >/dev/null || true
  say "-- round $round passed (code by $code_role, CLI was $role)"
  [ "$seen_initiator$seen_responder$seen_mac$seen_cli" = 1111 ] && [ "$round" -ge 2 ] && break
done

[ "$seen_initiator" = 1 ] || fail "never observed the CLI as INITIATOR against the Mac in $round rounds"
[ "$seen_responder" = 1 ] || fail "never observed the CLI as RESPONDER against the Mac in $round rounds"
[ "$seen_mac$seen_cli" = 11 ] || fail "both code roles were not exercised"
assert_run_was_local

say ""
say "== CLI ↔ macOS app link workspace: both code roles and both link roles, text, files, a folder,"
say "   consecutive batches both ways — LOOPBACK evidence (no decline/cancel: the peer cannot be driven to) =="
completed=1
