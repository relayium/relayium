#!/usr/bin/env bash
#
# **macOS native ↔ real browser, over a real pairing code, on a real server.**
#
#   ./scripts/native-web-pairing-acceptance.sh
#
# The cell nothing in this repository could fill. Every pairing-room test here is
# one client against a double: `code-room.mjs` replaces `window.WebSocket` with a
# BroadcastChannel fake and hands out an empty `iceServers`, and every Swift peer
# in `LinkPairingRoomTests` is Swift-authored. Both are useful, and neither can
# see a DISAGREEMENT between the two clients — which is exactly what the 1.2.5
# cross-network regression was: two capable peers, each individually correct,
# reaching different conclusions about what the other could speak.
#
# So this run has no double on either side:
#
#   * a real Relayium server built from ./server, on an ephemeral loopback port,
#     serving the real built Web bundle;
#   * a real pairing code minted through /api/pair by an account this run creates
#     through the product's own HTTP API;
#   * the macOS app's own `LinkWorkspaceModel`, assembled by `AppEnvironment`
#     exactly as `RelayiumApp` assembles it (`AppPairLinkHost`), in a separate
#     process;
#   * a real headless Chrome on the real bundle, joined to the same code;
#   * real WebRTC between them, on host candidates.
#
# ## What it proves, and in which direction
#
# Per round, in BOTH directions: the two clients reach ONE unified `link/1`
# workspace, agree on the SAS, and each receives the other's message and file
# with the bytes compared by digest.
#
# ## Both role assignments
#
# `linkRole` gives the smaller hub id the offer, and the hub assigns ids per
# socket at random — so one round exercises one assignment and says nothing about
# the other. A regression that only appears on one side reads as "fails about
# half the time", which is how the shipped one was written off. This runs rounds
# until it has seen the browser as initiator AND as responder, and FAILS if it
# has not seen both within its bound rather than reporting the half it got.
#
# ## What a GREEN run does NOT prove, stated so nobody over-reads it
#
# This is an end-to-end path check, not a race detector. Restoring the pre-fix
# asynchronous capability recording (the same-burst hello/offer race) and running
# five paced rounds here passed every one: on loopback the hello and the frame
# behind it rarely land in one delivery burst, and the main-actor hop usually
# wins. The deterministic evidence for that defect is
# `LinkPairingRoomTests.testAHelloAndAnOfferInOneBurstAreBothHonoured`, which
# fails when the fix is reverted. What this run proves is the thing no unit test
# can: that two DIFFERENT implementations agree — one workspace, one SAS, and the
# same bytes — over a real hub and real WebRTC, in both role assignments.
#
# ## Isolation
#
# `scripts/lib/local-acceptance.sh` owns every rule: ephemeral ports, one per-run
# temp root, receive roots inside it, tokens in the environment and never argv,
# PID-exact cleanup with no `pkill`, `RELAYIUM_RELEASE_CHECK=false`, loopback-only
# STUN. Nothing here reaches the network or a real account.
set -Eeuo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$here/.." && pwd)"
# shellcheck source-path=SCRIPTDIR
# shellcheck source=lib/local-acceptance.sh
source "$here/lib/local-acceptance.sh"

# How many pairings to run before giving up on seeing both role assignments.
# Each is an independent coin flip on the hub's random ids, so eight rounds miss
# a side with probability 2^-7 — small enough that a failure here is a signal
# rather than noise, and bounded enough that a wedged run ends.
max_rounds="${RELAYIUM_PAIRING_ROUNDS:-8}"

# Deliberately not ASCII-only, and deliberately whitespace-significant. The
# message rides an AEAD-sealed text frame and the file rides an encrypted
# manifest; anything that trims, normalises or re-encodes shows up here as a
# digest mismatch rather than as a vague size difference.
mac_message="mac → web: 你好 مرحبا 🌍 é"   # decomposed e + U+0301, deliberately
web_message="  web → mac:\n\n\tif x:\n   trailing   "
mac_file_name="mac-to-web.txt"
mac_file_body="from the mac: 端到端 — 0123456789"
web_file_name="web-to-mac.txt"
web_file_body="from the browser: 端到端 — 9876543210"

sha_of_string() { printf '%b' "$1" | shasum -a 256 | cut -d' ' -f1; }
hex_of_string() { printf '%b' "$1" | od -An -tx1 | tr -d ' \n'; }

acceptance_begin
acceptance_build "$repo/server" "$repo/apps/RelayiumKit"

# The Web bundle. Built here rather than assumed, because a stale `dist` would
# make this run evidence about a build nobody is shipping — and an ABSENT one
# would 404 into an unreadable "the peer never joined".
# `vite build` rather than `npm run build`, and the difference matters here.
# `npm run build` runs `gen-pages.mjs` first, which REWRITES the committed static
# pages under `web/public` — including the frozen locales — so a run of this
# script would leave the working tree dirty in files it has nothing to do with.
# Vite copies `web/public` into `dist` as it stands, which is also the more
# honest input: this run should exercise the bundle the repository would ship,
# not a regeneration of unrelated pages.
say "== building the Web bundle =="
(cd "$repo/web" && npx vite build >"$run_root/web-build.log" 2>&1) \
  || fail "the Web bundle failed to build: $(tail -20 "$run_root/web-build.log")"
[ -f "$repo/web/dist/index.html" ] || fail "web/dist/index.html is missing after the build"
acceptance_server_static="$repo/web/dist"

acceptance_start_server
acceptance_create_account

# The bundle really is being served, before anything waits on a browser that
# would otherwise time out on a blank page with no explanation.
curl -sf --max-time 10 "$origin/cross-network" | grep -q '<div id="app"' \
  || fail "the server is not serving the built Web app at $origin/cross-network"
say "-- the built Web bundle is served from $origin"

seen_initiator=0
seen_responder=0
compared_sas=0
round=0

while [ "$round" -lt "$max_rounds" ]; do
  round=$((round + 1))
  say ""

  # **Paced against the server's own join budget, which is production and must
  # not be relaxed for a test.** `wsJoinPerIPPerMinute` is 5 (server/wsroute.go),
  # and one round spends two `/ws?code=` joins from this one loopback address —
  # the Mac's room socket and the browser's. A third round inside the same minute
  # is refused, and the refusal surfaces as `.roomUnavailable` on the Mac and
  # "the peer never joined" in the browser: a red run that looks exactly like the
  # regression this script exists to detect. That confusion has already cost one
  # diagnosis here, so the wait is explicit rather than the limit being widened.
  if [ "$round" -gt 1 ]; then
    say "-- waiting out the server's per-IP join budget before round $round"
    sleep 65
  fi

  say "== round $round: one pairing code, one Mac, one browser =="

  # The Mac creates. That is the connect-first surface's own path —
  # `CrossNetworkConnectPane.mintAndWatch` — and it is the one the owner's
  # reports came from.
  peer_env=("RELAYIUM_ACCEPTANCE_ACCOUNT_TOKEN=$account_token")
  start_peer "mac-$round" pair-link --receive-root "$run_root/mac-receive-$round"
  mac_port="$peer_port"
  if [ "$round" -eq 1 ]; then
    assert_control_api_is_guarded "$mac_port"
  fi

  control "$mac_port" POST /start '{"action":"create"}' >/dev/null \
    || fail "the Mac peer refused to start"

  code=""
  for _ in $(seq 1 100); do
    code="$(json_field "$(control "$mac_port" GET /status || echo '{}')" code)"
    [ -n "$code" ] && break
    sleep 0.3
  done
  [ -n "$code" ] || fail "the Mac peer never minted a pairing code: $(control "$mac_port" GET /status)"
  say "-- the Mac minted $code and is watching the room"

  # The browser joins the same code, sends a message and a file, and waits for
  # the Mac's. It writes down what it OBSERVED; the comparisons are made here.
  browser_out="$run_root/browser-$round.json"
  # The FIRST round runs with advanced verification on, because that is the only
  # configuration in which the browser renders the six digits at all and
  # therefore the only one where the two clients' SAS can be compared. Every
  # later round runs on the shipped default, which is the path the owner's users
  # are on and the one the regression lived on. Neither alone would be enough.
  verify_mode=default
  [ "$round" -eq 1 ] && verify_mode=on
  (
    cd "$repo/web" && node e2e/native-pairing-browser.mjs \
      --origin "$origin" --code "$code" --out "$browser_out" \
      --debug-port "$((9460 + round))" --verify "$verify_mode" \
      --message "$(printf '%b' "$web_message")" \
      --file-name "$web_file_name" --file-body "$(printf '%b' "$web_file_body")" \
      --expect-name "$mac_file_name" --expect-message "$(printf '%b' "$mac_message")"
  ) >"$run_root/browser-$round.log" 2>&1 &
  browser_pid=$!
  register_child "browser-$round" "$browser_pid"

  # Meanwhile the Mac waits for the link and then sends its own half. Driven
  # from here rather than scripted into the peer, because what the Mac may send
  # depends on the browser having reached the workspace.
  # **`open(`, not merely `hasSession`.** A link publishes a session the moment
  # it starts establishing, and the lanes do not exist until the transport is
  # ready — sending into that gap answers "This connection isn't ready for that
  # yet", which is the product refusing correctly and this script asking wrongly.
  # The person on screen cannot reach it because the composer is not there yet.
  linked=0
  for _ in $(seq 1 200); do
    observed="$(control "$mac_port" GET /observed || echo '{}')"
    case "$observed" in
      *'"linkPhase": "open('*|*'"linkPhase":"open('*) linked=1; break ;;
    esac
    case "$observed" in
      *legacyFallback*) fail "the Mac fell back to the LEGACY wire against a current browser: $observed" ;;
    esac
    kill -0 "$browser_pid" 2>/dev/null \
      || fail "the browser half exited before a link existed: $(tail -30 "$run_root/browser-$round.log")"
    sleep 0.5
  done
  [ "$linked" = "1" ] \
    || fail "the Mac never reached an OPEN link/1 workspace: $(control "$mac_port" GET /observed)"
  say "-- the Mac reached a link/1 workspace"

  control "$mac_port" POST /drive \
    "$(printf '{"command":"message","body":%s}' "$(python3 -c '
import json, sys
print(json.dumps(sys.argv[1]))' "$(printf '%b' "$mac_message")")")" >/dev/null \
    || fail "the Mac refused to send a message"
  control "$mac_port" POST /drive \
    "$(python3 -c '
import json, sys
print(json.dumps({"command": "files", "name": sys.argv[1], "contents": sys.argv[2]}))' \
      "$mac_file_name" "$(printf '%b' "$mac_file_body")")" >/dev/null \
    || fail "the Mac refused to send a file"
  say "-- the Mac sent a message and a file"

  wait "$browser_pid" \
    || fail "the browser half failed: $(tail -40 "$run_root/browser-$round.log")"
  [ -f "$browser_out" ] || fail "the browser half wrote no observation"

  # ── the comparisons ──────────────────────────────────────────────────────
  mac_observed="$(control "$mac_port" GET /observed)"
  printf '%s\n' "$mac_observed" >"$run_root/mac-$round.json"

  python3 - "$browser_out" "$run_root/mac-$round.json" \
    "$(printf '%b' "$mac_message")" "$(printf '%b' "$web_message")" \
    "$mac_file_name" "$(hex_of_string "$mac_file_body")" \
    "$web_file_name" "$(sha_of_string "$web_file_body")" <<'PY' || fail "round $round did not agree"
import json, sys

browser = json.load(open(sys.argv[1]))
mac = json.load(open(sys.argv[2]))
mac_message, web_message = sys.argv[3], sys.argv[4]
mac_file_name, mac_file_hex = sys.argv[5], sys.argv[6]
web_file_name, web_file_sha = sys.argv[7], sys.argv[8]

problems = []

if not browser.get("reachedWorkspace"):
    problems.append("the browser never reached the unified workspace")
if not mac.get("hasSession"):
    problems.append("the Mac reports no live session")
if mac.get("legacyFallback"):
    problems.append("the Mac fell back to the legacy wire: %r" % (mac["legacyFallback"],))

# One link, one SAS, and the two sides derived the same six digits. This is the
# only cell in the matrix where that can be checked at all: the Swift vector and
# the Web test each check their own implementation against a frozen value, and
# neither has ever compared two live endpoints.
if browser.get("verify") == "on" and not browser.get("sas"):
    problems.append("the browser derived no SAS on the path that shows one")
elif browser.get("sas") and browser["sas"] != mac.get("sas"):
    problems.append("the two sides derived different SAS digits: browser %s, mac %s"
                    % (browser.get("sas"), mac.get("sas")))

# mac → web
if mac_message not in browser.get("receivedMessages", []):
    problems.append("the browser did not receive the Mac's message: %r"
                    % (browser.get("receivedMessages"),))
if browser.get("receivedFileName") != mac_file_name:
    problems.append("the browser received %r, not %r"
                    % (browser.get("receivedFileName"), mac_file_name))
if browser.get("receivedFileHex", "").lower() != mac_file_hex.lower():
    problems.append("the browser's bytes differ from what the Mac sent")

# web → mac
if web_message not in mac.get("messages", []):
    problems.append("the Mac did not receive the browser's message: %r" % (mac.get("messages"),))
files = {f.get("name"): f for f in mac.get("files", [])}
if web_file_name not in files:
    problems.append("the Mac did not write %r; it wrote %r" % (web_file_name, sorted(files)))
elif files[web_file_name].get("sha256", "").lower() != web_file_sha.lower():
    problems.append("the Mac's bytes differ from what the browser sent")

if problems:
    for p in problems:
        print("  - %s" % p, file=sys.stderr)
    print("browser: %s" % json.dumps(browser, ensure_ascii=False)[:2000], file=sys.stderr)
    print("mac:     %s" % json.dumps(mac, ensure_ascii=False)[:2000], file=sys.stderr)
    sys.exit(1)

print("-- round agreed: %s, both messages, both files byte-identical (browser was %s)"
      % ("SAS %s on both sides" % browser["sas"] if browser.get("sas")
         else "verification at its shipped default", browser.get("role")),
      file=sys.stderr)
PY

  if [ -n "$(json_field "$(cat "$browser_out")" sas)" ]; then
    compared_sas=1
  fi
  role="$(json_field "$(cat "$browser_out")" role)"
  case "$role" in
    initiator) seen_initiator=1 ;;
    responder) seen_responder=1 ;;
    *) fail "the browser could not name its role" ;;
  esac

  control "$mac_port" POST /shutdown >/dev/null || true
  say "-- round $round passed (browser was $role)"

  if [ "$seen_initiator" = "1" ] && [ "$seen_responder" = "1" ]; then
    break
  fi
done

[ "$seen_initiator" = "1" ] \
  || fail "never observed the browser as INITIATOR in $round rounds; half the role space is unproved"
[ "$seen_responder" = "1" ] \
  || fail "never observed the browser as RESPONDER in $round rounds; half the role space is unproved"
[ "$compared_sas" = "1" ] \
  || fail "no round compared the two clients' SAS digits; the one cell nothing else covers is unproved"

say ""
say "== macOS native ↔ real browser pairing: both role assignments, text and files, both directions =="
completed=1
