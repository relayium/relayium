#!/usr/bin/env bash
# Tests for scripts/check-production-identifiers.sh — above all for its
# FIXTURE_IP_EXCEPTIONS, the exact "path|ip" pairs that let the vendored
# upstream Pion TURN tests keep their fixture addresses.
#
# An exception is only safe while it stays exactly as narrow as written, so
# every entry is proved from both sides: its own file with its own address
# passes, and removing the entry from a copy of the checker turns that same
# fixture red (so the green came from the entry, not from a file the scan never
# saw). Around it, each way the exception could leak is a negative case — the
# same address in another file, another address in the excepted file, a
# lookalike path, a lookalike address — and the checks that must never consult
# it (known production IPs, production paths, node hostnames) still fire
# inside an excepted file.
#
# Every case runs the real checker inside a private, throwaway `git init`
# repository under $TMPDIR; nothing here touches the repository it lives in.
# The checker searches with `git grep`, i.e. only TRACKED files, so each
# fixture file is `git add`ed there. That is also the checker's known limit:
# a file that is not yet tracked is not scanned, so a local run before
# `git add` can pass on content that CI will then reject.
#
# This file is itself scanned by the checker in CI and must not trip it, so no
# address, production path or node hostname appears here as one literal: they
# are assembled from pieces at runtime. The last case scans a copy of this file
# to prove that, with a control that the scan really reads it.
#
# Plain bash 3.2 (macOS /bin/bash) and GNU/Linux compatible; needs only git.
set -u

here="$(cd "$(dirname "$0")" && pwd)"
repo_root="$(cd "$here/../.." && pwd)"
checker="$repo_root/scripts/check-production-identifiers.sh"
self="$here/$(basename "$0")"

failures=0
ok()  { printf 'ok   — %s\n' "$1"; }
bad() { printf 'FAIL — %s\n     %s\n' "$1" "$2"; failures=$((failures + 1)); }

work="$(mktemp -d "${TMPDIR:-/tmp}/production-identifiers-test.XXXXXX")"
trap 'rm -rf "$work"' EXIT

# The fixture repositories must not inherit the caller's repository, hooks or
# git configuration (a `grep.*` setting would change what `git grep` matches).
# GIT_CONFIG_GLOBAL replaces both ~/.gitconfig and $XDG_CONFIG_HOME/git/config,
# so HOME itself is left as the caller set it.
unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_OBJECT_DIRECTORY GIT_CEILING_DIRECTORIES
export GIT_CONFIG_NOSYSTEM=1
export GIT_CONFIG_GLOBAL=/dev/null

ip() { printf '%s.%s.%s.%s' "$1" "$2" "$3" "$4"; }

PION="server/third_party/pion-turn"
PERM="$PION/internal/client/permission_test.go"
PEER="$PION/internal/proto/peeraddr_test.go"
RELAYED="$PION/internal/proto/relayedaddr_test.go"
SERVER="$PION/server_test.go"

PERM_IP="$(ip 7 8 9 10)"
CODEC_IP="$(ip 111 11 1 2)"
VNET_IP="$(ip 1 2 3 5)"

# Taken from the checker's own denylist rather than spelled here: its pattern
# leaves the dots unescaped, so even the octets written apart would match.
KNOWN_BAD_IP="$(sed -n '/^KNOWN_BAD_IPS=(/{n;p;q;}' "$checker" | awk '{print $1}')"
STRANGER_IP="$(ip 45 67 89 12)"             # arbitrary public, never allowed
PROD_PATH="/opt/relay""ium/bin/cleanup.sh"
CERT_PATH="/etc/letsencrypt/live/relay""ium/fullchain.pem"
NODE_HOST="node""42.relay""ium.com"

case_no=0

case "$KNOWN_BAD_IP" in
  *.*.*.*) ;;
  *) bad "setup" "could not read a known production IP from $checker"; exit 1 ;;
esac

# new_repo — a fresh fixture repository holding a copy of the checker at its
# real path (so its self-exclusion behaves as in the product repository).
new_repo() {
  case_no=$((case_no + 1))
  repo="$work/case-$case_no"
  mkdir -p "$repo/scripts"
  git init -q "$repo"
  cp "$checker" "$repo/scripts/check-production-identifiers.sh"
}

# put <path> <line>… — write a file in the fixture and track it.
put() {
  local path="$1"; shift
  mkdir -p "$repo/$(dirname "$path")"
  : >"$repo/$path"
  local line
  for line in "$@"; do printf '%s\n' "$line" >>"$repo/$path"; done
  git -C "$repo" add -- "$path"
}

# without_entry <path> — delete that path's FIXTURE_IP_EXCEPTIONS entry from
# the fixture's copy of the checker, and require that it was there.
without_entry() {
  local target="$repo/scripts/check-production-identifiers.sh" rel="${1#"$PION"/}"
  grep -v "^  \"\$PION_TURN/$rel|" "$target" >"$target.new"
  if cmp -s "$target" "$target.new"; then
    bad "mutation setup" "no FIXTURE_IP_EXCEPTIONS entry found for $1"
  fi
  mv "$target.new" "$target"
}

run_checker() {
  out="$( cd "$repo" && bash scripts/check-production-identifiers.sh 2>&1 )"
  status=$?
}

expect_pass() {
  run_checker
  if [ "$status" -eq 0 ]; then ok "$1"; else bad "$1" "expected PASS, got exit $status: $out"; fi
}

# expect_fail <name> <exact violation line> — red, AND red for this line.
expect_fail() {
  run_checker
  if [ "$status" -eq 0 ]; then
    bad "$1" "expected FAIL, checker passed"
  elif ! printf '%s\n' "$out" | grep -qxF "  $2"; then
    bad "$1" "failed, but not with violation '$2': $out"
  else
    ok "$1"
  fi
}

go_line() { printf '\tassert.Equal(t, "%s", x)' "$1"; }

# --- the exception list is exactly the four reviewed pairs -------------------
actual_entries="$(sed -n '/^FIXTURE_IP_EXCEPTIONS=(/,/^)/p' "$checker" | sed -n 's/^  "\(.*\)"$/\1/p')"
expected_entries="$(printf '%s\n' \
  "\$PION_TURN/internal/client/permission_test.go|$PERM_IP" \
  "\$PION_TURN/internal/proto/peeraddr_test.go|$CODEC_IP" \
  "\$PION_TURN/internal/proto/relayedaddr_test.go|$CODEC_IP" \
  "\$PION_TURN/server_test.go|$VNET_IP")"
if [ "$actual_entries" = "$expected_entries" ] \
   && grep -qx 'PION_TURN="server/third_party/pion-turn"' "$checker"; then
  ok "FIXTURE_IP_EXCEPTIONS holds exactly the four reviewed path|ip pairs"
else
  bad "FIXTURE_IP_EXCEPTIONS holds exactly the four reviewed path|ip pairs" \
      "got: $actual_entries"
fi

# --- positive: each entry, then that entry removed ---------------------------
for pair in "$PERM|$PERM_IP|35" "$PEER|$CODEC_IP|20" "$RELAYED|$CODEC_IP|20" "$SERVER|$VNET_IP|3"; do
  path="${pair%%|*}"; rest="${pair#*|}"; addr="${rest%%|*}"; line="${rest#*|}"
  pad=()
  i=1; while [ "$i" -lt "$line" ]; do pad+=("// upstream line $i"); i=$((i + 1)); done

  new_repo
  put "$path" "${pad[@]}" "$(go_line "$addr:333")"
  expect_pass "exception: $addr in $path passes"

  new_repo
  put "$path" "${pad[@]}" "$(go_line "$addr:333")"
  without_entry "$path"
  expect_fail "control: same fixture is red once its entry is removed" "$path:$line:$addr"
done

new_repo
put "$PERM"    "$(go_line "$PERM_IP:5000")"
put "$PEER"    "$(go_line "$CODEC_IP:333")"
put "$RELAYED" "$(go_line "$CODEC_IP:333")"
put "$SERVER"  "$(go_line "$VNET_IP")" "$(go_line "$VNET_IP")"
put "server/internal/ok.go" "$(go_line "$(ip 1 2 3 4)")" "$(go_line "$(ip 10 0 0 1)")" \
    "$(go_line "$(ip 203 0 113 7)")"
expect_pass "all four fixtures together with ordinary allowlisted/private literals pass"

# --- negative: the same address outside its exact file -----------------------
new_repo
put "$PION/internal/client/allocation_test.go" "$(go_line "$PERM_IP:5000")"
expect_fail "same IP, sibling file in the same vendored package" \
  "$PION/internal/client/allocation_test.go:1:$PERM_IP"

new_repo
put "$PION/server.go" "$(go_line "$VNET_IP")"
expect_fail "same IP, non-test file of the vendored copy" "$PION/server.go:1:$VNET_IP"

new_repo
put "server/cmd/relayium-node/relay.go" "$(go_line "$CODEC_IP")"
expect_fail "same IP, product source" "server/cmd/relayium-node/relay.go:1:$CODEC_IP"

new_repo
put "docs/ops.md" "peer $VNET_IP"
expect_fail "same IP, documentation" "docs/ops.md:1:$VNET_IP"

new_repo
put "vendor/$PERM" "$(go_line "$PERM_IP")"
expect_fail "same IP, excepted path nested under another directory" "vendor/$PERM:1:$PERM_IP"

new_repo
put "$PERM.orig" "$(go_line "$PERM_IP")"
expect_fail "same IP, excepted path plus a suffix" "$PERM.orig:1:$PERM_IP"

new_repo
put "$SERVER" "$(go_line "$PERM_IP")"
expect_fail "another entry's IP in an excepted file is not exempt" "$SERVER:1:$PERM_IP"

# --- negative: other addresses inside an excepted file -----------------------
new_repo
put "$PERM" "$(go_line "$PERM_IP")" "$(go_line "$STRANGER_IP:80")"
expect_fail "different IP, same excepted file" "$PERM:2:$STRANGER_IP"

new_repo
put "$PERM" "$(go_line "$PERM_IP") $(go_line "$STRANGER_IP")"
expect_fail "different IP on the same line as the excepted one" "$PERM:1:$STRANGER_IP"

new_repo
put "$PERM" "$(go_line "$(ip 7 8 9 100)")"
expect_fail "lookalike IP with a longer last octet" "$PERM:1:$(ip 7 8 9 100)"

new_repo
put "$PEER" "$(go_line "$(ip 111 11 1 20)")"
expect_fail "lookalike IP with a longer last octet in a codec file" "$PEER:1:$(ip 111 11 1 20)"

new_repo
put "$SERVER" "$(go_line "$(ip 11 2 3 5)")"
expect_fail "lookalike IP with a longer first octet" "$SERVER:1:$(ip 11 2 3 5)"

# --- negative: unconditional checks still fire inside excepted files ---------
new_repo
put "$PERM" "$(go_line "$PERM_IP")" "$(go_line "$KNOWN_BAD_IP")"
expect_fail "known production IP inside an excepted file" "$PERM:2:$(go_line "$KNOWN_BAD_IP")"

new_repo
put "$SERVER" "$(go_line "$VNET_IP")" "// $PROD_PATH"
expect_fail "production path inside an excepted file" "$SERVER:2:// $PROD_PATH"

new_repo
put "$RELAYED" "// $CERT_PATH"
expect_fail "certificate path inside an excepted file" "$RELAYED:1:// $CERT_PATH"

new_repo
put "$PEER" "$(go_line "$CODEC_IP")" "// dial $NODE_HOST"
expect_fail "node hostname inside an excepted file" "$PEER:2:// dial $NODE_HOST"

# --- the pre-existing checks are unchanged -----------------------------------
new_repo
put "web/src/x.ts" "const a = '$STRANGER_IP'"
expect_fail "an ordinary public IP is still flagged" "web/src/x.ts:1:$STRANGER_IP"

new_repo
put "docs/y.md" "see $KNOWN_BAD_IP"
expect_fail "known production IP is still flagged anywhere" "docs/y.md:1:see $KNOWN_BAD_IP"

new_repo
put "deploy/z.sh" "run $PROD_PATH"
expect_fail "production path is still flagged" "deploy/z.sh:1:run $PROD_PATH"

new_repo
put "docs/h.md" "host $NODE_HOST"
expect_fail "unknown node hostname is still flagged" "docs/h.md:1:host $NODE_HOST"

new_repo
put "docs/clean.md" "$(ip 8 8 8 8) $(ip 192 168 1 1) $(ip 198 51 100 3) node3.relayium.com"
expect_pass "allowlisted IPs, private/documentation ranges and fixture hostnames pass"

# --- this file does not trip the checker -------------------------------------
new_repo
mkdir -p "$repo/scripts/test"
cp "$self" "$repo/scripts/test/production-identifiers-test.sh"
git -C "$repo" add -- scripts/test/production-identifiers-test.sh
expect_pass "this test file itself passes the checker"

printf '%s\n' "x = \"$STRANGER_IP\"" >>"$repo/scripts/test/production-identifiers-test.sh"
line_count="$(wc -l <"$repo/scripts/test/production-identifiers-test.sh" | tr -d ' ')"
expect_fail "control: the self-scan does read this file" \
  "scripts/test/production-identifiers-test.sh:$line_count:$STRANGER_IP"

echo
if [ "$failures" -ne 0 ]; then
  printf 'production-identifiers-test: %d FAILED\n' "$failures"
  exit 1
fi
printf 'production-identifiers-test: all %d fixture repositories behaved\n' "$case_no"
