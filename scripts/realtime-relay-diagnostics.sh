#!/usr/bin/env bash
#
# **Opt-in realtime RELAY diagnostics: local, controlled, numeric-only.**
#
#   scripts/realtime-relay-diagnostics.sh web          --out-dir DIR [--samples N] [--file-mib N]
#   scripts/realtime-relay-diagnostics.sh web-controls --out-dir DIR
#   scripts/realtime-relay-diagnostics.sh native       --out-dir DIR [--file-mib N] [--control direct-fallback]
#
# What it is: a diagnostic, not an acceptance gate and not a benchmark of the
# network. It runs a real transfer through a REAL TURN relay and records, per
# batch, where the time went on each side, using the product's own per-batch
# TransferSample plus the existing transport probe, and refuses any batch that
# did not actually travel relay↔relay.
#
#   * `web`: two Chrome tabs on the PRIVATE diagnostic bundle
#     (web/e2e/relay-diagnostics-build.mjs) meet in the code-room fixture; its
#     /api/ice carries one loopback TURN entry, so the product's own
#     chooseRtcConfig forces relay-only (web/e2e/realtime-relay-diagnostics.mjs).
#   * `web-controls`: every negative/response control of the web tier; each must
#     produce its stated outcome (see CONTROL_EXPECTATIONS in the core).
#   * `native`: the macOS app's own LinkWorkspaceModel (`AppPairLinkHost`, as in
#     native-web-pairing-acceptance.sh) against one Chrome on the private bundle,
#     over a real pairing code on a throwaway local server whose EXISTING TURN REST
#     configuration (-turn-urls, RELAYIUM_TURN_SECRET) points at the helper. No
#     server source, admission, quota or billing change: the helper reports no
#     usage anywhere. `--control direct-fallback` starts the same server WITHOUT
#     TURN and must be refused as not-relayed.
#
# The relay is scripts/interop/local-turn-fixture.go: the repository's own pinned
# pion/turn on 127.0.0.1, compiled against server/go.mod with `go build
# -overlay` (nothing is written under server/). It is not production-equivalent,
# and both endpoints and the relay share one host and one kernel: this proves the
# relay CODE PATH and per-phase attribution, never WAN behaviour, throughput or a
# speedup. Native phase detail is not exposed by the app model and is reported
# as null with a reason; native completion is an internal full-SHA match,
# exported as a boolean.
#
# Isolation, inherited from scripts/lib/local-acceptance.sh (sourced for its
# helpers only — its STUN-only `acceptance_start_server` and that guard are NOT
# used and are not changed): one 0700 run root, every listener on 127.0.0.1 and
# asserted so, PID-exact cleanup, tokens and the TURN secret in the environment
# and never argv, RELAYIUM_RELEASE_CHECK=false. The TURN secret, account,
# pairing code and file digests stay inside the run root, which is removed on a
# passing run; reports in --out-dir are built from whitelisted numeric/enum
# fields and scanned for the run's own secrets before they are written.
#
# Toolchains come from PATH: node (with web/node_modules installed), go, and for
# `native` swift. RELAYIUM_ACCEPTANCE_SWIFT_SCRATCH selects a private Swift build
# directory. scripts/test/local-turn-fixture-test.sh is this file's cheap gate.
set -Eeuo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$here/.." && pwd)"
# shellcheck source-path=SCRIPTDIR
# shellcheck source=lib/local-acceptance.sh
source "$here/lib/local-acceptance.sh"

usage() {
  say "usage: $0 web|web-controls|native --out-dir /absolute/dir [--samples N] [--file-mib N] [--control NAME]"
  exit 2
}

mode="${1:-}"
[ $# -gt 0 ] && shift
case "$mode" in web|web-controls|native) : ;; *) usage ;; esac
out_dir=""; samples=""; file_mib=""; diag_control=""
while [ $# -gt 0 ]; do
  [ $# -ge 2 ] || usage
  case "$1" in
    --out-dir) [ -z "$out_dir" ] || usage; out_dir="$2" ;;
    --samples) [ -z "$samples" ] || usage; samples="$2" ;;
    --file-mib) [ -z "$file_mib" ] || usage; file_mib="$2" ;;
    --control) [ -z "$diag_control" ] || usage; diag_control="$2" ;;
    *) usage ;;
  esac
  shift 2
done
case "$out_dir" in /*) : ;; *) usage ;; esac
for n in "$samples" "$file_mib"; do
  case "$n" in ''|[1-9]|[1-9][0-9]) : ;; *) usage ;; esac
done
if [ "$mode" = native ]; then
  [ -z "$samples" ] || usage
  case "$diag_control" in ''|direct-fallback) : ;; *) usage ;; esac
elif [ "$mode" = web-controls ]; then
  [ -z "$samples$file_mib$diag_control" ] || usage
fi
mkdir -p "$out_dir"

acceptance_begin
# Two task-owned 0700 directories OUTSIDE the run root. The existing workflow
# failure uploads glob `relayium-acceptance-*/**/*.{log,json}`, so anything the
# run root holds can be shipped as an artifact. `private` holds what must never
# be: the /api/ice body (a TURN REST credential) until it is parsed, the TURN
# counters, raw browser/native observations, the internal facts and the raw
# error log. `browser_tmp` holds Chrome profiles. `private` is removed on a
# passing run and kept (locally only, never uploaded) on a failing one.
private="$(mktemp -d "${TMPDIR:-/tmp}/relayium-relay-diag-private.XXXXXX")"
browser_tmp="$(mktemp -d "${TMPDIR:-/tmp}/relayium-relay-diag-browser.XXXXXX")"
chmod 700 "$private" "$browser_tmp"
acceptance_extra_cleanup() {
  rm -rf "$browser_tmp"
  if [ "$completed" = 1 ]; then rm -rf "$private"; else say "--- private diagnostics kept (not in any upload root): $private"; fi
}
export TMPDIR="$browser_tmp"

# Revoke an explicitly reaped child from the shared registry, so the EXIT
# cleanup can never signal a numeric PID that has been reused since. The
# shared library itself is not changed.
forget_child() {
  local gone="$1" i=0 n=${#child_pids[@]}
  local -a pids=() labels=()
  while [ "$i" -lt "$n" ]; do
    if [ "${child_pids[$i]}" != "$gone" ]; then pids+=("${child_pids[$i]}"); labels+=("${child_labels[$i]}"); fi
    i=$((i + 1))
  done
  child_pids=(${pids+"${pids[@]}"})
  child_labels=(${labels+"${labels[@]}"})
}

# A counters read that has stopped moving (the helper rewrites every 100 ms).
settled_counters() {
  local out="$1" a b _
  for _ in $(seq 1 30); do
    a="$(cat "$turn_status")"; sleep 0.25; b="$(cat "$turn_status")"
    if [ "$a" = "$b" ]; then printf '%s\n' "$b" >"$out"; return 0; fi
  done
  fail "the TURN helper's counters never settled"
}
report_tag="$(date -u +%Y%m%dT%H%M%SZ)-$run_tag"

# ── the loopback TURN helper ────────────────────────────────────────────────

build_turn_fixture() {
  local virtual="$repo/server/internal/zzrelaydiagturn"
  # The overlay adds a package that must not exist on disk; if it did, the
  # overlay would silently merge into somebody else's code.
  [ ! -e "$virtual" ] || fail "$virtual exists; refusing to overlay into it"
  python3 - "$virtual/main.go" "$repo/scripts/interop/local-turn-fixture.go" >"$run_root/turn-overlay.json" <<'PY'
import json, sys
print(json.dumps({"Replace": {sys.argv[1]: sys.argv[2]}}))
PY
  say "== building the loopback TURN helper (pinned server module, overlay) =="
  ( cd "$repo/server" && go build -tags relayiumdiag -overlay "$run_root/turn-overlay.json" \
      -o "$run_root/local-turn-fixture" ./internal/zzrelaydiagturn ) \
    || fail "the TURN helper did not build"
}

# Every TCP/UDP socket a PID holds must be bound to 127.0.0.1.
assert_loopback_only() {
  local pid="$1" label="$2" lines
  lines="$(lsof -nP -a -p "$pid" -i 2>/dev/null | tail -n +2 || true)"
  [ -n "$lines" ] || fail "$label holds no sockets at all, so loopback-only cannot be asserted"
  if printf '%s\n' "$lines" | awk '{print $9}' | grep -vqE '^127\.0\.0\.1:'; then
    fail "$label has a socket that is not bound to 127.0.0.1"
  fi
  say "-- $label listens on 127.0.0.1 only"
}

start_turn_fixture() {
  turn_secret="$(od -An -tx1 -N32 /dev/urandom | tr -d ' \n')"
  turn_status="$private/turn-status.json"
  RELAYIUM_DIAG_TURN_SECRET="$turn_secret" "$run_root/local-turn-fixture" \
    -status "$turn_status" -max-seconds 2400 \
    >"$run_root/turn.out" 2>"$run_root/turn.log" </dev/null &
  turn_pid=$!
  register_child turn "$turn_pid"
  turn_port=""
  local _
  for _ in $(seq 1 100); do
    turn_port="$(grep -o -m1 'RELAYIUM_TURN_FIXTURE_READY {"port":[0-9]*' "$run_root/turn.out" 2>/dev/null \
      | grep -o '[0-9]*$' || true)"
    [ -n "$turn_port" ] && break
    kill -0 "$turn_pid" 2>/dev/null || fail "the TURN helper exited: $(tail -5 "$run_root/turn.log")"
    sleep 0.1
  done
  [ -n "$turn_port" ] || fail "the TURN helper never announced its port"
  assert_loopback_only "$turn_pid" "the TURN helper"
}

build_bundle() {
  say "== building the PRIVATE diagnostic Web bundle =="
  bundle="$run_root/diagnostic-bundle"
  ( cd "$repo/web" && node e2e/relay-diagnostics-build.mjs --out "$bundle" ) >"$run_root/bundle.log" 2>&1 \
    || fail "the private diagnostic bundle failed to build: $(tail -20 "$run_root/bundle.log")"
}

run_web() {
  local out="$1"; shift
  RELAYIUM_DIAG_TURN_SECRET="$turn_secret" RELAYIUM_DIAG_TURN_PORT="$turn_port" \
    RELAYIUM_DIAG_TURN_STATUS="$turn_status" RELAYIUM_DIAG_PRIVATE_LOG="$private/web.log" \
    node "$repo/web/e2e/realtime-relay-diagnostics.mjs" --bundle "$bundle" --out "$out" "$@"
}

# ── the native tier ─────────────────────────────────────────────────────────

start_relay_server() {
  server_port="$(free_port)"
  origin="http://127.0.0.1:$server_port"
  mkdir -p "$run_root/blobs"
  local -a turn_args=()
  # Never interpolate the secret into anything printed: the label is separate.
  local secret_env="" turn_label="none (direct-fallback control)"
  if [ "$diag_control" != direct-fallback ]; then
    turn_args=(-turn-urls "turn:127.0.0.1:$turn_port")
    secret_env="$turn_secret"
    turn_label="the loopback helper"
  fi
  say "== starting a throwaway server on $origin (TURN: $turn_label) =="
  RELAYIUM_RELEASE_CHECK=false RELAYIUM_TURN_SECRET="$secret_env" \
    "$run_root/relayium-server" \
    -addr "127.0.0.1:$server_port" -db "$run_root/relayium.db" -blob-dir "$run_root/blobs" \
    -static "$bundle" -stun-urls "$loopback_stun" ${turn_args+"${turn_args[@]}"} \
    -mail-transport dev-log-links >"$run_root/server.log" 2>&1 &
  server_pid=$!
  register_child server "$server_pid"
  local _
  for _ in $(seq 1 100); do
    curl -sf --max-time 5 "$origin/api/config" >/dev/null 2>&1 && break
    kill -0 "$server_pid" 2>/dev/null || fail "the server exited: $(tail -5 "$run_root/server.log")"
    sleep 0.2
  done
  curl -sf --max-time 5 "$origin/api/config" >/dev/null 2>&1 || fail "the server never became reachable"
  assert_loopback_only "$server_pid" "the local server"
  control_token="$(od -An -tx1 -N32 /dev/urandom | tr -d ' \n')"
  export RELAYIUM_ACCEPTANCE_CONTROL_TOKEN="$control_token"
}

# What /api/ice issues for THIS code: loopback TURN entries only, with REST
# credentials, no pool. Prints counts only; the body stays in the run root.
check_issued_ice() {
  local code="$1"
  curl -sf --max-time 15 "$origin/api/ice?code=$code" -o "$private/ice.json" \
    || fail "could not read /api/ice for the pairing code"
  # Fault stage for the upload-scope control: fail while the credential-bearing
  # body is still on disk, and prove no upload glob can select it.
  maybe_fault ice-fetched
  python3 - "$private/ice.json" "$diag_control" >"$private/ice-facts.json" <<'PY' || { rm -f "$private/ice.json"; fail "/api/ice did not issue what this run requires"; }
import json, sys
doc = json.load(open(sys.argv[1]))
control = sys.argv[2]
turn = stun = 0
for entry in doc.get("iceServers") or []:
    for url in entry.get("urls") or []:
        scheme = url.partition(":")[0].lower()
        rest = url.partition(":")[2].split("?")[0]
        host = rest.rsplit(":", 1)[0].strip("[]")
        if host != "127.0.0.1":
            sys.exit("an ICE URL is not on 127.0.0.1")
        if scheme == "turn":
            turn += 1
            if not (entry.get("username") and entry.get("credential")):
                sys.exit("a TURN entry has no REST credential")
        elif scheme == "stun":
            stun += 1
        else:
            sys.exit("unexpected ICE scheme")
if doc.get("relays"):
    sys.exit("a relay pool was offered")
if control == "direct-fallback" and turn:
    sys.exit("the direct-fallback control was offered TURN")
if control != "direct-fallback" and turn < 1:
    sys.exit("no TURN entry was issued for the code (relayDenied=%r)" % doc.get("relayDenied"))
print(json.dumps({"iceTurnUrlCount": turn, "iceStunUrlCount": stun, "iceLoopbackOnly": True}))
PY
  # The body holds a TURN REST credential: provisioning material, never kept
  # where a failure upload could carry it.
  rm -f "$private/ice.json"
  say "-- /api/ice for the code: $(cat "$private/ice-facts.json")"
}

native_landed() {
  python3 - "$1" "$2" "$3" <<'PY'
import json, sys
try:
    o = json.loads(sys.argv[1])
except Exception:
    sys.exit(1)
got = any(f.get("name") == sys.argv[2] and f.get("sha256", "").lower() == sys.argv[3] for f in o.get("files", []))
sys.exit(0 if got else 1)
PY
}

run_native() {
  local out="$1" bytes=$((${file_mib:-8} * 1024 * 1024))
  acceptance_build "$repo/server" "$repo/apps/RelayiumKit"
  start_relay_server
  acceptance_create_account

  # The two synthetic files: same generators as the browser half and the
  # staged native source, digests computed here and kept in the run root.
  local web_name="web-to-native.bin" native_name="native-to-web.bin"
  mkdir -p "$run_root/native-staged"
  python3 - "$bytes" "$run_root/native-staged/$native_name" "$private/digests.json" <<'PY'
import hashlib, json, sys
n = int(sys.argv[1])
web = bytes((i * 37 + 11) % 251 for i in range(n))
native = bytes((i * 31 + 7) % 251 for i in range(n))
open(sys.argv[2], "wb").write(native)
json.dump({"web": hashlib.sha256(web).hexdigest(), "native": hashlib.sha256(native).hexdigest()}, open(sys.argv[3], "w"))
PY
  local web_sha native_sha
  web_sha="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["web"])' "$private/digests.json")"
  native_sha="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["native"])' "$private/digests.json")"

  peer_env=("RELAYIUM_ACCEPTANCE_ACCOUNT_TOKEN=$account_token")
  start_peer mac pair-link --receive-root "$run_root/mac-receive"
  mac_port="$peer_port"
  assert_control_api_is_guarded "$mac_port"
  control "$mac_port" POST /start '{"action":"create"}' >/dev/null || fail "the native peer refused to start"
  local code="" _
  for _ in $(seq 1 100); do
    code="$(json_field "$(control "$mac_port" GET /status || echo '{}')" code)"
    [ -n "$code" ] && break
    sleep 0.3
  done
  [ -n "$code" ] || fail "the native peer never minted a pairing code"
  check_issued_ice "$code"
  settled_counters "$private/turn-before.json"

  local browser_raw="$private/browser-diagnostics.json" browser_out="$private/browser.json"
  local ready="$private/browser.ready" release="$private/browser.release" armed="$private/browser.recv-armed"
  # Control knob only: delay the browser's receive arming to prove the barrier.
  local arm_delay="${RELAYIUM_DIAG_RECV_ARM_DELAY_MS:-0}"
  case "$arm_delay" in [0-9]|[1-9][0-9]|[1-9][0-9][0-9]|[1-9][0-9][0-9][0-9]|1[0-9][0-9][0-9][0-9]|20000) : ;;
    *) fail "RELAYIUM_DIAG_RECV_ARM_DELAY_MS must be 0..20000" ;; esac
  (
    cd "$repo/web" && exec node e2e/native-pairing-browser.mjs \
      --origin "$origin" --code "$code" --out "$browser_out" --debug-port "$(free_port)" --verify default \
      --message "web to native" --file-name "$web_name" --file-size "$bytes" \
      --expect-name "$native_name" --expect-message "native to web" \
      --ready-file "$ready" --release-file "$release" --relay-diagnostics "$browser_raw" \
      --recv-armed-file "$armed" --recv-arm-delay-ms "$arm_delay"
  ) >"$run_root/browser.log" 2>&1 &
  local browser_pid=$!
  register_child browser "$browser_pid"

  local linked=0 observed
  for _ in $(seq 1 240); do
    observed="$(control "$mac_port" GET /observed || echo '{}')"
    case "$observed" in *'"linkPhase": "open('*|*'"linkPhase":"open('*) linked=1; break ;; esac
    case "$observed" in *legacyFallback*) fail "the native peer fell back to the legacy wire" ;; esac
    kill -0 "$browser_pid" 2>/dev/null || fail "the browser half exited before a link existed: $(tail -30 "$run_root/browser.log")"
    sleep 0.5
  done
  [ "$linked" = 1 ] || fail "the native peer never reached an open link/1 workspace"
  say "-- the native peer reached a link/1 workspace"

  local landed=0
  for _ in $(seq 1 480); do
    observed="$(control "$mac_port" GET /observed || echo '{}')"
    if native_landed "$observed" "$web_name" "$web_sha"; then landed=1; break; fi
    kill -0 "$browser_pid" 2>/dev/null || fail "the browser half exited before its file reached the native peer: $(tail -30 "$run_root/browser.log")"
    sleep 0.5
  done
  [ "$landed" = 1 ] || fail "the browser's file never reached the native peer with the right digest"
  local landed_ms; landed_ms="$(python3 -c 'import time; print(int(time.time()*1000))')"
  say "-- web → native batch landed with the right digest"

  # ── barrier: the native send starts only once the browser has seen its own
  # batch COMPLETE, finished that batch's observation and armed the receive one.
  # Landing on the native side implies none of that.
  local armed_ok=0
  for _ in $(seq 1 120); do
    if [ -f "$armed" ]; then
      [ "$(cat "$armed")" = "$code" ] || fail "the receive-armed marker names another code"
      armed_ok=1; break
    fi
    kill -0 "$browser_pid" 2>/dev/null || fail "the browser half exited before arming its receive observation: $(tail -30 "$run_root/browser.log")"
    sleep 0.25
  done
  [ "$armed_ok" = 1 ] || fail "the browser never armed its receive observation within 30s"
  settled_counters "$private/turn-mid.json"
  local drive_ms; drive_ms="$(python3 -c 'import time; print(int(time.time()*1000))')"
  say "-- receive observation armed; native send released $((drive_ms - landed_ms)) ms after the web batch landed (arm delay ${arm_delay} ms)"
  printf '{"landedToDriveMs":%s,"armDelayMs":%s}\n' "$((drive_ms - landed_ms))" "$arm_delay" >"$private/barrier.json"

  control "$mac_port" POST /drive '{"command":"message","body":"native to web"}' >/dev/null \
    || fail "the native peer refused to send a message"
  control "$mac_port" POST /drive "$(python3 -c '
import json, sys
print(json.dumps({"command": "stagedFile", "name": sys.argv[1], "path": sys.argv[2]}))' \
    "$native_name" "$run_root/native-staged/$native_name")" >/dev/null \
    || fail "the native peer refused to send its staged file"
  say "-- native → web batch started"

  local tick
  for tick in $(seq 1 600); do
    [ -f "$ready" ] && break
    kill -0 "$browser_pid" 2>/dev/null || fail "the browser half exited before publishing: $(tail -40 "$run_root/browser.log")"
    sleep 0.5
  done
  [ -f "$ready" ] || fail "the browser never published its observation"
  settled_counters "$private/turn-after.json"
  control "$mac_port" GET /observed >"$private/native-observed.json"
  kill -0 "$browser_pid" 2>/dev/null || fail "the browser half exited while holding the link"

  python3 - "$private/native-observed.json" "$browser_out" "$web_name" "$web_sha" "$native_name" "$native_sha" "$bytes" \
    "$private/ice-facts.json" >"$private/native-facts.json" <<'PY' || fail "could not derive the native facts"
import json, sys
mac = json.load(open(sys.argv[1])); browser = json.load(open(sys.argv[2]))
web_name, web_sha, native_name, native_sha, n = sys.argv[3], sys.argv[4], sys.argv[5], sys.argv[6], int(sys.argv[7])
ice = json.load(open(sys.argv[8]))
facts = {
    "nativeLinkOpen": str(mac.get("linkPhase", "")).startswith("open("),
    "nativeLegacyFallback": bool(mac.get("legacyFallback")),
    "nativeReceivedWebFileVerified": any(f.get("name") == web_name and f.get("size") == n
                                          and f.get("sha256", "").lower() == web_sha for f in mac.get("files", [])),
    "webReceivedNativeFileVerified": browser.get("receivedFileName") == native_name
        and browser.get("receivedFileBytes") == n and browser.get("receivedFileSha256", "").lower() == native_sha,
    "nativeReceivedMessage": "web to native" in mac.get("messages", []),
    "webReceivedMessage": "native to web" in browser.get("receivedMessages", []),
    "nativeReportsRelayedBound": isinstance(mac.get("relayExpiresAtMs"), int),
    "browserRole": browser.get("role") if browser.get("role") in ("initiator", "responder") else None,
    "fileBytes": n,
}
facts.update(ice)
print(json.dumps(facts))
PY
  : >"$release"
  local browser_status=0
  wait "$browser_pid" || browser_status=$?
  forget_child "$browser_pid"
  [ "$browser_status" = 0 ] || fail "the browser half failed after its release: $(tail -40 "$run_root/browser.log")"
  control "$mac_port" POST /shutdown >/dev/null || true

  RELAYIUM_DIAG_SENTINELS="$(printf '%s\n' "$turn_secret" "$code" "$account_email" "$web_sha" "$native_sha")" \
    node "$repo/web/e2e/realtime-relay-diagnostics.mjs" assemble-native \
      --raw "$browser_raw" --facts "$private/native-facts.json" \
      --turn-before "$private/turn-before.json" --turn-mid "$private/turn-mid.json" --turn-after "$private/turn-after.json" \
      ${diag_control:+--control "$diag_control"} --out "$out"
}

build_turn_fixture
start_turn_fixture
build_bundle

case "$mode" in
  web)
    args=()
    [ -n "$samples" ] && args+=(--samples "$samples")
    [ -n "$file_mib" ] && args+=(--file-mib "$file_mib")
    [ -n "$diag_control" ] && args+=(--control "$diag_control")
    run_web "$out_dir/relay-web-$report_tag.json" ${args+"${args[@]}"} || fail "the web relay diagnostics did not pass"
    ;;
  web-controls)
    for c in direct-fallback wrong-credential bad-hash observer-throws cancel slow-receiver; do
      say "== control: $c =="
      run_web "$out_dir/relay-web-control-$c-$report_tag.json" --control "$c" \
        || fail "control $c did not produce its expected outcome"
    done
    ;;
  native)
    run_native "$out_dir/relay-native${diag_control:+-control-$diag_control}-$report_tag.json" \
      || fail "the native relay diagnostics did not produce their expected outcome"
    ;;
esac

say ""
say "== realtime relay diagnostics ($mode) complete; reports in $out_dir =="
completed=1
