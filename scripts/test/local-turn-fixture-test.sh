#!/usr/bin/env bash
#
# The cheap gate for the realtime relay diagnostics' loopback TURN helper
# (scripts/interop/local-turn-fixture.go) and for the privacy and isolation
# rules of scripts/realtime-relay-diagnostics.sh that a single run cannot show.
#
#   scripts/test/local-turn-fixture-test.sh
#
# Needs `go` on PATH (the server module's toolchain). Everything runs on
# 127.0.0.1 inside one private temporary directory, removed on the way out.
#
# What it proves, by EXECUTING the helper rather than reading it:
#   * it refuses to start without a secret, with a short one, with a relative
#     or non-private status path, with an out-of-range lifetime or extra args;
#   * `-self-check` drives a real pion client through it: a UDP and a TCP
#     allocation each relay a payload byte-exactly and are counted under their
#     own transport, and a wrong password and an expired username are refused;
#   * it listens on 127.0.0.1 only, the secret is in no argv, no counters file,
#     no stdout and no stderr, and the counters file has exactly its whitelisted
#     keys;
#   * it ends on SIGTERM, on stdin EOF when asked to, and at -max-seconds, each
#     time writing a final counters file that names why.
# And, statically, of the runner: it never prints a secret-bearing variable,
# never uses the STUN-only `acceptance_start_server` (whose guard stays exactly
# as it is), and the overlay target it builds into does not exist on disk.
set -Eeuo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$here/../.." && pwd)"
fixture_src="$repo/scripts/interop/local-turn-fixture.go"
runner="$repo/scripts/realtime-relay-diagnostics.sh"
library="$repo/scripts/lib/local-acceptance.sh"
virtual="$repo/server/internal/zzrelaydiagturn"

work="$(mktemp -d "${TMPDIR:-/tmp}/relay-turn-fixture-test.XXXXXX")"
chmod 700 "$work"
pids=()
cleanup() {
  local pid
  for pid in ${pids+"${pids[@]}"}; do kill -TERM "$pid" 2>/dev/null || true; done
  for pid in ${pids+"${pids[@]}"}; do wait "$pid" 2>/dev/null || true; done
  rm -rf "$work"
}
trap cleanup EXIT

failures=0
ok() { printf '  ok   %s\n' "$*"; }
bad() { printf '  FAIL %s\n' "$*" >&2; failures=$((failures + 1)); }

# ── static guards ───────────────────────────────────────────────────────────

[ ! -e "$virtual" ] && ok "the overlay target $virtual does not exist on disk" \
  || bad "$virtual exists; the helper's overlay would merge into it"
grep -q '^//go:build relayiumdiag$' "$fixture_src" \
  && ok "the helper is behind the relayiumdiag build tag" || bad "the helper lost its build tag"
# Every line that prints (say/emit/echo/printf/fail) must not expand a variable
# that holds the TURN secret. The one deliberate exception is the sentinel list,
# which goes into an environment variable for the report's privacy scan.
leaks="$(grep -nE '\b(say|emit|echo|printf|fail)\b' "$runner" \
  | grep -E '\$\{?(turn_secret|secret_env|account_token|control_token)' \
  | grep -v 'RELAYIUM_DIAG_SENTINELS=' || true)"
[ -z "$leaks" ] && ok "the runner prints no secret-bearing variable" || bad "the runner prints a secret: $leaks"
grep -nE '(^|[^_])acceptance_start_server' "$runner" | grep -v '^\s*[0-9]*:\s*#' | grep -q . \
  && bad "the runner calls the STUN-only acceptance_start_server" \
  || ok "the runner does not use the STUN-only acceptance_start_server"
grep -q 'is not STUN: a local run must never be offered a relay' "$library" \
  && ok "the STUN-only local-acceptance guard is still in place" || bad "the STUN-only local-acceptance guard is gone"
grep -q -- '-turn-urls' "$library" && bad "the shared acceptance library now configures TURN" \
  || ok "the shared acceptance library still configures no TURN"
# The secret travels in the environment: never as an argument to any command.
grep -nE -- '--?(turn-)?secret[ =]' "$runner" | grep -q . \
  && bad "the runner passes a secret as an argument" || ok "the runner passes no secret as an argument"

# Raw/provisioning material lives outside every upload root: `private` is its
# own mktemp directory, never a path under the run root.
grep -qE '^private="\$\(mktemp -d "\$\{TMPDIR:-/tmp\}/relayium-relay-diag-private\.' "$runner" \
  && ! grep -qE 'private="\$run_root' "$runner" \
  && ok "private diagnostics live outside the run root (and its failure-upload globs)" \
  || bad "private diagnostics are not in their own directory outside the run root"

# forget_child, executed: an explicitly reaped child leaves the shared registry,
# and the shared library's EXIT cleanup (run here with `kill` mocked to RECORD
# signals) never targets it. The library itself is sourced unchanged.
signals="$work/signals"
(
  # shellcheck source=../lib/local-acceptance.sh
  source "$library"
  eval "$(sed -n '/^forget_child() {$/,/^}$/p' "$runner")"
  # Alive until TERMed, so the cleanup really sends its TERM.
  kill() { printf '%s\n' "$*" >>"$signals"; case "$1" in -0) ! grep -q -- "-TERM $2\$" "$signals" ;; *) return 0 ;; esac; }
  wait() { :; }
  child_labels=(server browser turn); child_pids=(41001 41002 41003)
  forget_child 41002
  [ "${child_pids[*]}" = "41001 41003" ] && [ "${child_labels[*]}" = "server turn" ] || exit 3
  terminate_children
) && ok "forget_child removes exactly the reaped entry from the shared registry" || bad "forget_child left the registry wrong"
if [ -f "$signals" ] && ! grep -q 41002 "$signals" && grep -q -- '-TERM 41001$' "$signals" && grep -q -- '-TERM 41003$' "$signals"; then
  ok "the EXIT cleanup signals the live children and never the reaped PID"
else
  bad "the EXIT cleanup signalled a reaped PID or recorded nothing: $(cat "$signals" 2>/dev/null)"
fi
# Causal: the same cleanup WITHOUT forget_child does target it.
: >"$signals"
( source "$library"; kill() { printf '%s\n' "$*" >>"$signals"; case "$1" in -0) ! grep -q -- "-TERM $2\$" "$signals" ;; *) return 0 ;; esac; }; wait() { :; }
  child_labels=(server browser); child_pids=(41001 41002); terminate_children )
grep -q -- '-TERM 41002$' "$signals" && ok "control: without forget_child the cleanup would signal the reaped PID" \
  || bad "control did not show the cleanup targeting an unrevoked PID"

# ── build ───────────────────────────────────────────────────────────────────

printf '{"Replace":{"%s/main.go":"%s"}}\n' "$virtual" "$fixture_src" >"$work/overlay.json"
( cd "$repo/server" && go build -tags relayiumdiag -overlay "$work/overlay.json" -o "$work/fixture" ./internal/zzrelaydiagturn ) \
  && ok "the helper builds against the pinned server module" || { bad "the helper does not build"; exit 1; }
[ ! -e "$virtual" ] && ok "building left nothing under server/" || bad "building wrote $virtual"

mkdir -m 700 "$work/st"
secret="$(od -An -tx1 -N24 /dev/urandom | tr -d ' \n')"

# ── refusals ────────────────────────────────────────────────────────────────

refuses() {
  local label="$1"; shift
  if "$@" >"$work/refusal.out" 2>&1 </dev/null; then bad "$label was accepted"; else ok "refuses $label"; fi
}
refuses "a missing secret" env -u RELAYIUM_DIAG_TURN_SECRET "$work/fixture" -status "$work/st/a.json"
refuses "a short secret" env RELAYIUM_DIAG_TURN_SECRET=short "$work/fixture" -status "$work/st/a.json"
refuses "a relative status path" env RELAYIUM_DIAG_TURN_SECRET="$secret" "$work/fixture" -status st/a.json
mkdir -m 755 "$work/open"
refuses "a non-private status directory" env RELAYIUM_DIAG_TURN_SECRET="$secret" "$work/fixture" -status "$work/open/a.json"
refuses "an out-of-range lifetime" env RELAYIUM_DIAG_TURN_SECRET="$secret" "$work/fixture" -status "$work/st/a.json" -max-seconds 0
refuses "extra arguments" env RELAYIUM_DIAG_TURN_SECRET="$secret" "$work/fixture" -status "$work/st/a.json" extra
[ ! -e "$work/st/a.json" ] && ok "no refusal wrote a counters file" || bad "a refused start wrote a counters file"

# ── a real client through the real server ───────────────────────────────────

if RELAYIUM_DIAG_TURN_SECRET="$secret" "$work/fixture" -status "$work/st/check.json" -self-check -max-seconds 60 \
    >"$work/check.out" 2>"$work/check.err" </dev/null \
    && grep -q '^RELAYIUM_TURN_FIXTURE_SELFCHECK PASS$' "$work/check.out"; then
  ok "self-check: UDP and TCP allocations relay byte-exactly; wrong and expired credentials refused"
else
  bad "self-check failed: $(cat "$work/check.out" "$work/check.err")"
fi

keys_ok() {
  python3 - "$1" "$2" <<'PY'
import json, sys
doc = json.load(open(sys.argv[1]))
want = {"version", "final", "exitReason", "authAccepted", "authRejected", "allocations", "relaySocketsClosed",
        "permissions", "channels", "allocationErrors", "relayBytesToPeer", "relayBytesFromPeer"}
if set(doc) - want or not {"version", "final"} <= set(doc):
    sys.exit("unexpected counters keys: %r" % sorted(set(doc) ^ want))
for group in ("allocations", "relayBytesToPeer", "relayBytesFromPeer"):
    if set(doc[group]) != {"udp", "tcp", "unknown"} or not all(isinstance(v, int) for v in doc[group].values()):
        sys.exit("malformed %s" % group)
for k, v in doc.items():
    if k not in ("allocations", "relayBytesToPeer", "relayBytesFromPeer", "final", "exitReason") and not isinstance(v, int):
        sys.exit("non-integer %s" % k)
if sys.argv[2] and doc.get("exitReason") != sys.argv[2]:
    sys.exit("exitReason %r, want %r" % (doc.get("exitReason"), sys.argv[2]))
PY
}
keys_ok "$work/st/check.json" self-check-passed && ok "the self-check counters have exactly the whitelisted keys" \
  || bad "self-check counters malformed"
python3 - "$work/st/check.json" <<'PY' && ok "the counters attribute each allocation to its own transport" || bad "per-transport attribution is wrong"
import json, sys
d = json.load(open(sys.argv[1]))
assert d["allocations"]["udp"] >= 1 and d["allocations"]["tcp"] >= 1, d
assert d["relayBytesToPeer"]["udp"] >= 1200 and d["relayBytesToPeer"]["tcp"] >= 1200, d
assert d["relayBytesToPeer"]["unknown"] == 0 and d["authRejected"] >= 1, d
PY

# ── isolation and lifetimes ─────────────────────────────────────────────────

RELAYIUM_DIAG_TURN_SECRET="$secret" "$work/fixture" -status "$work/st/live.json" -max-seconds 60 \
  >"$work/live.out" 2>"$work/live.err" </dev/null &
live=$!; pids+=("$live")
for _ in $(seq 1 50); do grep -q READY "$work/live.out" 2>/dev/null && break; sleep 0.1; done
if grep -qE '^RELAYIUM_TURN_FIXTURE_READY \{"port":[0-9]+\}$' "$work/live.out"; then ok "announces its port"; else bad "never announced a port"; fi
sockets="$(lsof -nP -a -p "$live" -i 2>/dev/null | tail -n +2 | awk '{print $9}' || true)"
if [ -n "$sockets" ] && ! printf '%s\n' "$sockets" | grep -vqE '^127\.0\.0\.1:'; then
  ok "listens on 127.0.0.1 only ($(printf '%s\n' "$sockets" | wc -l | tr -d ' ') sockets)"
else
  bad "a socket is not bound to 127.0.0.1: $sockets"
fi
argv="$(ps -o command= -p "$live" || true)"
case "$argv" in *"$secret"*) bad "the secret is visible in argv" ;; *) ok "the secret is not in argv" ;; esac
kill -TERM "$live"; wait "$live" 2>/dev/null || true
# Reaped: revoke it so the EXIT cleanup can never signal a reused PID.
pids=()
keys_ok "$work/st/live.json" signal:terminated && ok "SIGTERM ends it with a final counters file" || bad "SIGTERM did not end it cleanly"

RELAYIUM_DIAG_TURN_SECRET="$secret" "$work/fixture" -status "$work/st/eof.json" -exit-on-stdin-eof -max-seconds 60 \
  >"$work/eof.out" 2>"$work/eof.err" </dev/null && keys_ok "$work/st/eof.json" stdin-closed \
  && ok "-exit-on-stdin-eof ends it when the owner's pipe closes" || bad "stdin EOF did not end it"

if RELAYIUM_DIAG_TURN_SECRET="$secret" "$work/fixture" -status "$work/st/max.json" -max-seconds 1 \
    >"$work/max.out" 2>"$work/max.err" </dev/null; then
  bad "reaching -max-seconds exited 0"
else
  keys_ok "$work/st/max.json" max-seconds && ok "-max-seconds bounds its lifetime and exits non-zero" || bad "-max-seconds final state wrong"
fi

leak="$(grep -l "$secret" "$work"/st/*.json "$work"/*.out "$work"/*.err 2>/dev/null || true)"
[ -z "$leak" ] && ok "the secret appears in no counters file, stdout or stderr" || bad "the secret leaked into: $leak"

if [ "$failures" -ne 0 ]; then
  printf 'local-turn-fixture-test: %d failure(s)\n' "$failures" >&2
  exit 1
fi
printf 'local-turn-fixture-test: all checks passed\n'
