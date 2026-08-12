#!/bin/sh
# Decision-matrix tests for web/public/uninstall-node.sh.
#
# That script's whole job is to make destroying blobs by accident impossible:
# every stored file binds to exactly one node and there are no replicas. Every
# bug found in it so far has been a shell bug with the same ending — blobs
# silently rm -rf'd, exit 0, "relayium-node uninstalled." — so it gets tests.
#
# Each case builds a scratch install tree (the script's RELAYIUM_NODE_PREFIX
# hook), stubs systemctl/userdel/groupdel/curl on PATH, and asserts BOTH the
# exit status AND exactly which files survived. Refusal cases compare a full
# before/after listing of the tree, so "nothing was deleted" is checked
# literally rather than spot-checked. EVERY case asserts surviving files, not
# just an exit status: the bugs this suite exists for all exited 0.
#
# Exit statuses under test:
#   0  uninstalled, nothing left behind
#   1  refused — nothing was deleted and the node was not deregistered
#   2  uninstalled, but something unrecognised was in the way and was KEPT
#
# POSIX sh on purpose: so is the script under test.
#   sh scripts/test/uninstall-node-test.sh
#
# Lives next to its subject in this (public) repo, and runs in CI — see
# .github/workflows/repo-hygiene.yml. It spent 2026-07-25..26 in the private ops
# repo, carried there by the open-core split's wholesale move of deploy/, where
# it could not find web/public/uninstall-node.sh and failed every case with
# rc=127. A test separated from its subject dies quietly; keep them together.
set -u

HERE=$(CDPATH='' cd -P -- "$(dirname -- "$0")" && pwd -P)
SCRIPT="$HERE/../../web/public/uninstall-node.sh"
BASEPATH="$PATH"

TMPROOT=$(mktemp -d "${TMPDIR:-/tmp}/uninstall-node-test.XXXXXX")
trap 'rm -rf "$TMPROOT"' EXIT
trap 'rm -rf "$TMPROOT"; exit 1' INT HUP TERM

fail=0
ok() { printf '  ok   %s\n' "$1"; }
bad() {
  printf '  FAIL %s\n' "$1"
  fail=1
}
check_rc() {
  if [ "$2" = "$3" ]; then ok "$1"; else
    bad "$1"
    printf '       want rc=%s got rc=%s\n' "$3" "$2"
    sed 's/^/       | /' "$TMPROOT/err" | head -n 5
  fi
}
check_eq() {
  if [ "$2" = "$3" ]; then ok "$1"; else
    bad "$1"
    printf '       want=[%s]\n       got =[%s]\n' "$3" "$2"
  fi
}
# -e follows symlinks and -L catches dangling ones; a file "survives" if either.
present() { [ -e "$1" ] || [ -L "$1" ]; }
assert_present() {
  if present "$1"; then ok "$2"; else bad "$2 (missing: $1)"; fi
}
assert_gone() {
  if present "$1"; then bad "$2 (still there: $1)"; else ok "$2"; fi
}

# ---------------------------------------------------------------------------
# Stubs. The real commands would touch the machine running the tests.
# ---------------------------------------------------------------------------
STUB="$TMPROOT/stub"
mkdir -p "$STUB"
for c in systemctl userdel groupdel; do
  printf '#!/bin/sh\nexit 0\n' >"$STUB/$c"
  chmod +x "$STUB/$c"
done
cat >"$STUB/curl" <<EOF
#!/bin/sh
echo "curl \$*" >> "$TMPROOT/curl.log"
exit 0
EOF
chmod +x "$STUB/curl"
# A second stub layer, used only for the "must refuse BEFORE deleting anything"
# cases: those name real system roots (/, //var, /var/lib/.), and a regression
# in the guard would otherwise run rm -rf on the developer's machine. It logs
# instead of deleting, so the assertion is literally "rm was never called".
STUBRM="$TMPROOT/stubrm"
mkdir -p "$STUBRM"
cat >"$STUBRM/rm" <<EOF
#!/bin/sh
echo "rm \$*" >> "$TMPROOT/rm.log"
exit 0
EOF
chmod +x "$STUBRM/rm"
# A find that cannot run at all (exit 127), for the "the count failed" case. The
# script must not read a failed count as "this node holds nothing".
STUBFIND="$TMPROOT/stubfind"
mkdir -p "$STUBFIND"
cat >"$STUBFIND/find" <<'EOF'
#!/bin/sh
echo "find: not found" >&2
exit 127
EOF
chmod +x "$STUBFIND/find"
# An rm that fails for one specific path, so the "purge could not delete the
# storage directory" branch can be exercised without an unwritable filesystem
# (which behaves differently when the tests happen to run as root).
STUBRMFAIL="$TMPROOT/stubrmfail"
mkdir -p "$STUBRMFAIL"
cat >"$STUBRMFAIL/rm" <<'EOF'
#!/bin/sh
for a in "$@"; do
  case $a in
    */nuke-fail*) echo "rm: $a: Operation not permitted" >&2; exit 1 ;;
  esac
done
exec /bin/rm "$@"
EOF
chmod +x "$STUBRMFAIL/rm"

RUNPATH="$STUB:$BASEPATH"

# newtree NAME — a scratch tree holding everything the installer creates.
newtree() {
  d="$TMPROOT/$1"
  rm -rf "$d"
  mkdir -p "$d/etc/relayium-node" \
    "$d/etc/systemd/system/multi-user.target.wants" \
    "$d/etc/systemd/system/timers.target.wants" \
    "$d/etc/systemd/system/paths.target.wants" \
    "$d/usr/local/bin" "$d/var/lib/relayium-node"
  printf '{"nodeID":"n-1"}' >"$d/var/lib/relayium-node/state.json"
  : >"$d/var/lib/relayium-node/id.key"
  : >"$d/var/lib/relayium-node/dl.key"
  : >"$d/var/lib/relayium-node/dl.crt"
  : >"$d/var/lib/relayium-node/last-heartbeat"
  : >"$d/usr/local/bin/relayium-node"
  : >"$d/usr/local/bin/relayium-node.prev"
  : >"$d/usr/local/bin/relayium-node.prev.tmp"
  : >"$d/etc/systemd/system/relayium-node.service"
  : >"$d/etc/systemd/system/relayium-node-update.service"
  : >"$d/etc/systemd/system/relayium-node-update.timer"
  : >"$d/etc/systemd/system/relayium-node-update-request.path"
  ln -s ../relayium-node.service \
    "$d/etc/systemd/system/multi-user.target.wants/relayium-node.service"
  ln -s ../relayium-node-update.timer \
    "$d/etc/systemd/system/timers.target.wants/relayium-node-update.timer"
  ln -s ../relayium-node-update-request.path \
    "$d/etc/systemd/system/paths.target.wants/relayium-node-update-request.path"
  printf '%s' "$d"
}

# blobs DIR N — N stored files in DIR.
blobs() {
  mkdir -p "$1"
  i=1
  while [ "$i" -le "$2" ]; do
    printf 'ciphertext%s' "$i" >"$1/blob-$i"
    i=$((i + 1))
  done
}

# envfile PREFIX [LINE ...] — write /etc/relayium-node/env verbatim.
envfile() {
  d=$1
  shift
  {
    echo "RELAYIUM_CENTRAL_URL=https://central.example"
    echo "RELAYIUM_NODE_TOKEN=tok"
    for line in "$@"; do echo "$line"; done
  } >"$d/etc/relayium-node/env"
}

snap() { (CDPATH='' cd -P -- "$1" && find . | sort); }

# run PREFIX [VAR=VAL ...] — invoke the uninstaller against a scratch tree.
run() {
  pre=$1
  shift
  : >"$TMPROOT/curl.log"
  : >"$TMPROOT/rm.log"
  (
    PATH="$RUNPATH"
    export PATH
    exec env RELAYIUM_NODE_PREFIX="$pre" "$@" sh "$SCRIPT"
  ) >"$TMPROOT/out" 2>"$TMPROOT/err"
}

deregistered() { [ -s "$TMPROOT/curl.log" ]; }
assert_no_deregister() {
  if deregistered; then bad "$1 (it deregistered the node)"; else ok "$1"; fi
}

echo "uninstall-node.sh"

# --- 1. storage unaccounted for: no env file, blobs nested in the state dir ---
p=$(newtree c1)
blobs "$p/var/lib/relayium-node/blobs" 2
before=$(snap "$p")
run "$p"
rc=$?
check_rc "unknown storage: refuses" "$rc" 1
check_eq "unknown storage: deletes nothing" "$(snap "$p")" "$before"
assert_no_deregister "unknown storage: does not deregister"
if grep -q "RELAYIUM_NODE_ASSUME_NO_STORAGE" "$TMPROOT/err"; then
  ok "unknown storage: names the ASSUME_NO_STORAGE override, not FORCE"
else
  bad "unknown storage: names the ASSUME_NO_STORAGE override, not FORCE"
fi
# The refusal must not hand over a guessed path: an operator whose blobs live
# elsewhere pastes it and the run destroys them.
if grep -q "RELAYIUM_NODE_STORAGE_DIR=/var" "$TMPROOT/err"; then
  bad "unknown storage: suggests no guessed blob path"
else
  ok "unknown storage: suggests no guessed blob path"
fi
# FORCE must NOT be the escape hatch here. It means "uninstall although files are
# still held" and PRESERVES storage; letting it also mean "delete the state dir
# including the blobs inside it" makes an operator who learned the first meaning
# wrong exactly once, unrecoverably.
before=$(snap "$p")
run "$p" RELAYIUM_NODE_FORCE=1
rc=$?
check_rc "unknown storage + FORCE=1: still refuses" "$rc" 1
check_eq "unknown storage + FORCE=1: deletes nothing" "$(snap "$p")" "$before"
# ASSUME_NO_STORAGE lets the run proceed — but it is a statement about the
# STORAGE directory, never a licence to delete files nobody recognises. The
# blobs sitting in the state dir here are exactly the ones a wrong "this node
# stores nothing" used to destroy, so this case asserts they are still there.
run "$p" RELAYIUM_NODE_ASSUME_NO_STORAGE=1
rc=$?
check_rc "unknown storage + ASSUME_NO_STORAGE=1: proceeds, reports leftovers" "$rc" 2
assert_present "$p/var/lib/relayium-node/blobs/blob-1" \
  "unknown storage + ASSUME_NO_STORAGE=1: unrecognised files survive"
assert_present "$p/var/lib/relayium-node" \
  "unknown storage + ASSUME_NO_STORAGE=1: state dir kept, not rm -rf'd"
assert_gone "$p/var/lib/relayium-node/state.json" \
  "unknown storage + ASSUME_NO_STORAGE=1: known state files removed"
assert_gone "$p/usr/local/bin/relayium-node" \
  "unknown storage + ASSUME_NO_STORAGE=1: binary still removed"
if grep -q "KEPT" "$TMPROOT/out"; then
  ok "unknown storage + ASSUME_NO_STORAGE=1: says what it kept"
else
  bad "unknown storage + ASSUME_NO_STORAGE=1: says what it kept"
fi

# --- 2. storage declared through the environment ---
p=$(newtree c2)
mkdir -p "$p/var/lib/relayium-node/blobs"
run "$p" "RELAYIUM_NODE_STORAGE_DIR=$p/var/lib/relayium-node/blobs"
rc=$?
check_rc "storage from env: uninstalls" "$rc" 0
assert_present "$p/var/lib/relayium-node/blobs" "storage from env: keeps storage dir"
assert_gone "$p/var/lib/relayium-node/state.json" "storage from env: removes state files"
# dl.key is the private key of a 15-year Cloudflare Origin CA certificate for
# this node's download hostname, under a Full (strict) zone. Left behind on a
# machine the operator believes was wiped, it plus a DNS repoint is a clean
# origin takeover — so its removal gets its own assertion, not just "state
# files removed".
assert_gone "$p/var/lib/relayium-node/dl.key" "storage from env: removes the origin CA private key"
assert_gone "$p/var/lib/relayium-node/dl.crt" "storage from env: removes the origin certificate"

# --- 3. storage declared through the env file ---
p=$(newtree c3)
envfile "$p" "RELAYIUM_NODE_STORAGE_DIR=$p/var/lib/relayium-node/blobs"
mkdir -p "$p/var/lib/relayium-node/blobs"
run "$p"
rc=$?
check_rc "storage from env file: uninstalls" "$rc" 0
assert_present "$p/var/lib/relayium-node/blobs" "storage from env file: keeps storage dir"
assert_gone "$p/var/lib/relayium-node/state.json" "storage from env file: removes state files"
assert_gone "$p/etc/relayium-node" "storage from env file: removes the conf dir"

# --- 4. the environment wins over the env file ---
# File points at a tree holding 2 files (which would refuse); the environment
# points at an empty one. Success proves the environment won, and the file's
# tree must still be there afterwards.
p=$(newtree c4)
envfile "$p" "RELAYIUM_NODE_STORAGE_DIR=$p/mnt/old-blobs"
blobs "$p/mnt/old-blobs" 2
mkdir -p "$p/mnt/new-blobs"
run "$p" "RELAYIUM_NODE_STORAGE_DIR=$p/mnt/new-blobs"
rc=$?
check_rc "env var wins over env file" "$rc" 0
assert_present "$p/mnt/old-blobs/blob-1" "env var wins: the file's tree is untouched"

# --- 5/6/7. env-file value with whitespace, double quotes, single quotes ---
# All three must PARSE. Non-empty storage then refuses, which is the observable
# proof: an unparsed value looks like "no blobs here" and deletes them.
for variant in space dquote squote; do
  p=$(newtree "c5-$variant")
  blobs "$p/var/lib/relayium-node/blobs" 2
  case $variant in
    space) val="   $p/var/lib/relayium-node/blobs   " ;;
    dquote) val="\"$p/var/lib/relayium-node/blobs\"" ;;
    squote) val="'$p/var/lib/relayium-node/blobs'" ;;
  esac
  envfile "$p" "RELAYIUM_NODE_STORAGE_DIR=$val"
  before=$(snap "$p")
  run "$p"
  rc=$?
  check_rc "env-file value ($variant): refuses, storage is understood" "$rc" 1
  check_eq "env-file value ($variant): deletes nothing" "$(snap "$p")" "$before"
  # And it is understood as a real directory, not merely unresolvable: with
  # FORCE the run completes and the blobs are recognised as storage, so they
  # survive. A value the parser mangled would refuse here instead.
  run "$p" RELAYIUM_NODE_FORCE=1
  rc=$?
  check_rc "env-file value ($variant): FORCE=1 proceeds" "$rc" 0
  assert_present "$p/var/lib/relayium-node/blobs/blob-1" \
    "env-file value ($variant): blobs survive FORCE"
done

# --- 8. storage is a symlink pointing INTO the state dir ---
p=$(newtree c8)
blobs "$p/var/lib/relayium-node/blobs" 2
mkdir -p "$p/mnt"
ln -s "$p/var/lib/relayium-node/blobs" "$p/mnt/link"
envfile "$p" "RELAYIUM_NODE_STORAGE_DIR=$p/mnt/link"
before=$(snap "$p")
run "$p"
rc=$?
check_rc "symlinked storage (into state dir): refuses" "$rc" 1
check_eq "symlinked storage (into state dir): deletes nothing" "$(snap "$p")" "$before"

# --- 9. storage is a symlink pointing OUT to another tree ---
p=$(newtree c9)
blobs "$p/mnt/data/blobs" 2
ln -s "$p/mnt/data/blobs" "$p/var/lib/relayium-node/blobs"
envfile "$p" "RELAYIUM_NODE_STORAGE_DIR=$p/var/lib/relayium-node/blobs"
before=$(snap "$p")
run "$p"
rc=$?
check_rc "symlinked storage (out of state dir): refuses" "$rc" 1
check_eq "symlinked storage (out of state dir): deletes nothing" "$(snap "$p")" "$before"
assert_no_deregister "symlinked storage (out of state dir): does not deregister"

# --- 10. declared storage directory that does not exist (typo) ---
p=$(newtree c10)
blobs "$p/var/lib/relayium-node/blobs" 2
envfile "$p" "RELAYIUM_NODE_STORAGE_DIR=$p/var/lib/relayium-node/blob"
before=$(snap "$p")
run "$p"
rc=$?
check_rc "typo'd storage path: refuses" "$rc" 1
check_eq "typo'd storage path: deletes nothing" "$(snap "$p")" "$before"
assert_no_deregister "typo'd storage path: does not deregister"

# ...and the explicit override gets past it — without destroying the blobs that
# the typo'd path failed to describe. They are in the state dir; the run must
# keep them and say so.
run "$p" RELAYIUM_NODE_ASSUME_NO_STORAGE=1
rc=$?
check_rc "typo'd storage path + ASSUME_NO_STORAGE: proceeds, reports leftovers" "$rc" 2
assert_present "$p/var/lib/relayium-node/blobs/blob-1" \
  "typo'd storage path + ASSUME_NO_STORAGE: blobs survive"
assert_gone "$p/var/lib/relayium-node/state.json" \
  "typo'd storage path + ASSUME_NO_STORAGE: known state files removed"

# --- 11. STORAGE_DIR == STATE_DIR, with and without a trailing slash ---
for suffix in '' '/'; do
  p=$(newtree "c11$(printf '%s' "$suffix" | tr '/' 's')")
  blobs "$p/var/lib/relayium-node" 2
  run "$p" RELAYIUM_NODE_FORCE=1 \
    "RELAYIUM_NODE_STORAGE_DIR=$p/var/lib/relayium-node$suffix"
  rc=$?
  check_rc "storage == state dir ('$suffix'): uninstalls" "$rc" 0
  assert_present "$p/var/lib/relayium-node/blob-1" \
    "storage == state dir ('$suffix'): blobs survive"
  assert_gone "$p/var/lib/relayium-node/state.json" \
    "storage == state dir ('$suffix'): state files removed"
  assert_gone "$p/var/lib/relayium-node/last-heartbeat" \
    "storage == state dir ('$suffix'): heartbeat removed"
done

# --- 12. non-empty storage, no FORCE ---
p=$(newtree c12)
blobs "$p/var/lib/relayium-node/blobs" 3
envfile "$p" "RELAYIUM_NODE_STORAGE_DIR=$p/var/lib/relayium-node/blobs"
before=$(snap "$p")
run "$p"
rc=$?
check_rc "holds files, no FORCE: refuses" "$rc" 1
check_eq "holds files, no FORCE: deletes nothing" "$(snap "$p")" "$before"
assert_no_deregister "holds files, no FORCE: does not deregister"

# --- 13. FORCE=1 keeps the storage; FORCE=1 + PURGE=1 removes it ---
p=$(newtree c13)
blobs "$p/var/lib/relayium-node/blobs" 3
envfile "$p" "RELAYIUM_NODE_STORAGE_DIR=$p/var/lib/relayium-node/blobs"
run "$p" RELAYIUM_NODE_FORCE=1
rc=$?
check_rc "FORCE=1: uninstalls" "$rc" 0
assert_present "$p/var/lib/relayium-node/blobs/blob-1" "FORCE=1: storage survives"
assert_gone "$p/var/lib/relayium-node/state.json" "FORCE=1: state files removed"
if deregistered; then ok "FORCE=1: deregisters"; else bad "FORCE=1: deregisters"; fi

p=$(newtree c13b)
blobs "$p/var/lib/relayium-node/blobs" 3
envfile "$p" "RELAYIUM_NODE_STORAGE_DIR=$p/var/lib/relayium-node/blobs"
run "$p" RELAYIUM_NODE_FORCE=1 RELAYIUM_NODE_PURGE_STORAGE=1
rc=$?
check_rc "FORCE=1 PURGE=1: uninstalls" "$rc" 0
assert_gone "$p/var/lib/relayium-node/blobs" "FORCE=1 PURGE=1: storage removed"

# --- 14. relay-only node: storage key present but empty ---
p=$(newtree c14)
envfile "$p" "RELAYIUM_NODE_STORAGE_DIR="
run "$p"
rc=$?
check_rc "relay-only node: uninstalls" "$rc" 0
assert_gone "$p/var/lib/relayium-node" "relay-only node: state dir removed"

# --- 15. all installer artifacts are removed ---
assert_gone "$p/usr/local/bin/relayium-node" "artifacts: binary removed"
assert_gone "$p/usr/local/bin/relayium-node.prev" "artifacts: .prev removed"
assert_gone "$p/usr/local/bin/relayium-node.prev.tmp" "artifacts: .prev.tmp removed"
assert_gone "$p/etc/systemd/system/relayium-node.service" "artifacts: service unit removed"
assert_gone "$p/etc/systemd/system/relayium-node-update.service" "artifacts: update service removed"
assert_gone "$p/etc/systemd/system/relayium-node-update.timer" "artifacts: update timer removed"
assert_gone "$p/etc/systemd/system/multi-user.target.wants/relayium-node.service" \
  "artifacts: multi-user.target.wants symlink removed"
assert_gone "$p/etc/systemd/system/timers.target.wants/relayium-node-update.timer" \
  "artifacts: timers.target.wants symlink removed"
# The update-request path unit is the one that can START a root unit when a file
# appears. Leaving it (or its enable symlink) behind on an uninstalled host
# means a root-triggering watcher outliving the thing it was installed for —
# the exact category of leftover this section exists to catch.
assert_gone "$p/etc/systemd/system/relayium-node-update-request.path" \
  "artifacts: update-request path unit removed"
assert_gone "$p/etc/systemd/system/paths.target.wants/relayium-node-update-request.path" \
  "artifacts: paths.target.wants symlink removed"
assert_gone "$p/etc/relayium-node" "artifacts: /etc/relayium-node removed"

# --- 16. pathological purge targets are rejected before anything is deleted ---
RUNPATH="$STUBRM:$STUB:$BASEPATH"
for danger in '/' '//var' '/var' '/var/lib/.' '/usr//'; do
  p=$(newtree "c16")
  run "$p" RELAYIUM_NODE_PURGE_STORAGE=1 RELAYIUM_NODE_FORCE=1 \
    "RELAYIUM_NODE_STORAGE_DIR=$danger"
  rc=$?
  check_rc "purge '$danger': refuses" "$rc" 1
  check_eq "purge '$danger': ran no rm at all" "$(cat "$TMPROOT/rm.log")" ""
done

# --- 17. the state directory gets the same reject list ---
for danger in '/' '/var/lib' '/var/lib/.'; do
  p=$(newtree "c17")
  envfile "$p" "RELAYIUM_NODE_STATE_DIR=$danger" "RELAYIUM_NODE_STORAGE_DIR="
  run "$p"
  rc=$?
  check_rc "state dir '$danger': refuses" "$rc" 1
  check_eq "state dir '$danger': ran no rm at all" "$(cat "$TMPROOT/rm.log")" ""
done
RUNPATH="$STUB:$BASEPATH"

# --- 18. the re-run-the-installer downgrade ---------------------------------
# The most reachable route into the old bug, and this script's own advice leads
# to it: "if an update went wrong, re-run the installer". The installer rewrites
# /etc/relayium-node/env from its arguments, so re-running the base command
# without RELAYIUM_NODE_STORAGE_DIR leaves `RELAYIUM_NODE_STORAGE_DIR=` — a
# perfectly well-formed "this node is relay-only" — while the blobs are still
# sitting in the state dir. Every guard passes; the state dir used to be
# rm -rf'd with the blobs inside it, exit 0, "relayium-node uninstalled."
p=$(newtree c18)
blobs "$p/var/lib/relayium-node/blobs" 4
envfile "$p" "RELAYIUM_NODE_STORAGE_DIR="
run "$p"
rc=$?
check_rc "downgraded env (relay-only) with blobs in the state dir: keeps them" "$rc" 2
assert_present "$p/var/lib/relayium-node/blobs/blob-1" \
  "downgraded env: blob 1 survives"
assert_present "$p/var/lib/relayium-node/blobs/blob-4" \
  "downgraded env: blob 4 survives"
assert_gone "$p/var/lib/relayium-node/state.json" "downgraded env: state.json removed"
assert_gone "$p/var/lib/relayium-node/id.key" "downgraded env: id.key removed"
assert_gone "$p/usr/local/bin/relayium-node" "downgraded env: binary removed"
assert_gone "$p/etc/relayium-node" "downgraded env: conf dir removed"
# (matched loosely: the script reports the RESOLVED path, and $TMPDIR is a
# symlink on some systems.)
if grep -q "KEPT .*var/lib/relayium-node" "$TMPROOT/out"; then
  ok "downgraded env: names the directory it kept"
else
  bad "downgraded env: names the directory it kept"
fi
if grep -q "blobs" "$TMPROOT/out"; then
  ok "downgraded env: lists what is in the way"
else
  bad "downgraded env: lists what is in the way"
fi

# --- 19. storage lives UNDER the configuration directory --------------------
# `rm -rf "$CONF_DIR"` had no guard of any kind: not the reject list, not an
# equality or nesting test against storage or state. Blobs under
# /etc/relayium-node were deleted there, and the script then printed the
# "left N file(s) … untouched" notice about files it had already destroyed.
p=$(newtree c19)
blobs "$p/etc/relayium-node/blobs" 3
envfile "$p" "RELAYIUM_NODE_STORAGE_DIR=$p/etc/relayium-node/blobs"
run "$p" RELAYIUM_NODE_FORCE=1
rc=$?
check_rc "storage under the conf dir: keeps it" "$rc" 2
assert_present "$p/etc/relayium-node/blobs/blob-1" "storage under conf dir: blobs survive"
assert_present "$p/etc/relayium-node/blobs/blob-3" "storage under conf dir: all blobs survive"
assert_gone "$p/etc/relayium-node/env" "storage under conf dir: env file removed"
assert_gone "$p/usr/local/bin/relayium-node" "storage under conf dir: binary removed"

# --- 20. storage IS the configuration directory -----------------------------
p=$(newtree c20)
blobs "$p/etc/relayium-node" 3
envfile "$p" "RELAYIUM_NODE_STORAGE_DIR=$p/etc/relayium-node"
run "$p" RELAYIUM_NODE_FORCE=1
rc=$?
check_rc "storage == conf dir: keeps it" "$rc" 2
assert_present "$p/etc/relayium-node/blob-1" "storage == conf dir: blobs survive"
assert_present "$p/etc/relayium-node/blob-3" "storage == conf dir: all blobs survive"
assert_gone "$p/etc/relayium-node/env" "storage == conf dir: env file removed"

# --- 21. the env file is LAST-wins, like systemd's EnvironmentFile ----------
# Appending a corrected line is the obvious way to fix a path by hand, and the
# node obeys the last one. Reading the first made this script look at a stale
# directory: here the first is an empty decoy and the second holds the blobs, so
# reading the wrong one uninstalls silently instead of refusing.
p=$(newtree c21)
mkdir -p "$p/mnt/stale"
blobs "$p/mnt/current" 2
envfile "$p" "RELAYIUM_NODE_STORAGE_DIR=$p/mnt/stale" \
  "RELAYIUM_NODE_STORAGE_DIR=$p/mnt/current"
before=$(snap "$p")
run "$p"
rc=$?
check_rc "env file last-wins: refuses on the LAST storage line" "$rc" 1
check_eq "env file last-wins: deletes nothing" "$(snap "$p")" "$before"
if grep -q "mnt/current" "$TMPROOT/err" && ! grep -q "mnt/stale" "$TMPROOT/err"; then
  ok "env file last-wins: names the last value, not the first"
else
  bad "env file last-wins: names the last value, not the first"
fi

# --- 22. environment and env file disagree ----------------------------------
# Both refusal messages tell the operator to pass a path, so passing a
# wrong-but-existing one is a realistic mistake — and it silently overrode a
# correct value sitting in the env file. It still wins (the operator may be
# fixing a stale file), but the disagreement is now shouted about by name.
p=$(newtree c22)
blobs "$p/mnt/real-blobs" 2
mkdir -p "$p/mnt/empty"
envfile "$p" "RELAYIUM_NODE_STORAGE_DIR=$p/mnt/real-blobs"
run "$p" "RELAYIUM_NODE_STORAGE_DIR=$p/mnt/empty"
rc=$?
check_rc "storage paths disagree: proceeds with the one passed" "$rc" 0
assert_present "$p/mnt/real-blobs/blob-1" "storage paths disagree: the env file's tree is untouched"
if grep -q "DISAGREE" "$TMPROOT/err" &&
  grep -q "$p/mnt/empty" "$TMPROOT/err" &&
  grep -q "$p/mnt/real-blobs" "$TMPROOT/err"; then
  ok "storage paths disagree: warns, naming both paths"
else
  bad "storage paths disagree: warns, naming both paths"
fi

# --- 23. the file count FAILED, which is not "there are no files" -----------
# find's exit status used to be discarded along with its stderr, so an
# unreadable storage directory (chmod 111, NFS root_squash) or a missing find
# counted zero — and zero is the answer that unlocks the deletion.
p=$(newtree c23)
blobs "$p/mnt/blobs" 2
envfile "$p" "RELAYIUM_NODE_STORAGE_DIR=$p/mnt/blobs"
before=$(snap "$p")
RUNPATH="$STUBFIND:$STUB:$BASEPATH"
run "$p"
rc=$?
check_rc "unlistable storage: refuses" "$rc" 1
check_eq "unlistable storage: deletes nothing" "$(snap "$p")" "$before"
assert_no_deregister "unlistable storage: does not deregister"
if grep -q "not found" "$TMPROOT/err"; then
  ok "unlistable storage: shows why find failed"
else
  bad "unlistable storage: shows why find failed"
fi
# FORCE is the documented way out, and it preserves storage.
run "$p" RELAYIUM_NODE_FORCE=1
rc=$?
RUNPATH="$STUB:$BASEPATH"
check_rc "unlistable storage + FORCE=1: proceeds" "$rc" 0
assert_present "$p/mnt/blobs/blob-1" "unlistable storage + FORCE=1: storage untouched"
assert_gone "$p/var/lib/relayium-node" "unlistable storage + FORCE=1: state dir removed"

# --- 24. a symlink INSIDE the storage tree ----------------------------------
# The case `find -L` actually exists for, and the one the suite was missing: a
# shard directory pointed at the big disk. Without -L find never descends it and
# reports zero files for a node holding thousands. (Cases 8/9 do NOT cover this:
# there the storage root itself is the link, and realdir has already resolved it
# before find runs.)
p=$(newtree c24)
mkdir -p "$p/mnt/store"
blobs "$p/mnt/big/shard-0" 2
ln -s "$p/mnt/big/shard-0" "$p/mnt/store/shard-0"
envfile "$p" "RELAYIUM_NODE_STORAGE_DIR=$p/mnt/store"
before=$(snap "$p")
run "$p"
rc=$?
check_rc "symlinked shard inside storage: refuses" "$rc" 1
check_eq "symlinked shard inside storage: deletes nothing" "$(snap "$p")" "$before"
assert_no_deregister "symlinked shard inside storage: does not deregister"

# --- 25. the binary is where the env file says it is ------------------------
# The installer records RELAYIUM_NODE_BIN. The uninstaller used to re-derive the
# path from RELAYIUM_INSTALL_DIR's default instead, so a node installed to a
# custom directory reported success with the binary, its rollback copy and the
# half-written rollback copy all still on disk — and a leftover .prev makes the
# next install refuse to start.
p=$(newtree c25)
mkdir -p "$p/opt/bin"
: >"$p/opt/bin/relayium-node"
: >"$p/opt/bin/relayium-node.prev"
: >"$p/opt/bin/relayium-node.prev.tmp"
envfile "$p" "RELAYIUM_NODE_STORAGE_DIR=" "RELAYIUM_NODE_BIN=/opt/bin/relayium-node"
run "$p"
rc=$?
check_rc "custom install dir: uninstalls" "$rc" 0
assert_gone "$p/opt/bin/relayium-node" "custom install dir: binary removed"
assert_gone "$p/opt/bin/relayium-node.prev" "custom install dir: .prev removed"
assert_gone "$p/opt/bin/relayium-node.prev.tmp" "custom install dir: .prev.tmp removed"

# --- 26. the state dir sits INSIDE the storage tree -------------------------
# The nesting test only ever asked "is storage inside state?". The other
# direction reached `rm -rf "$STATE_REAL"` with the storage tree's own files
# under it. The allowlist covers it from the other side: unrecognised files keep
# their directory alive whichever way round the two are.
p=$(newtree c26)
blobs "$p/mnt/store" 2
mkdir -p "$p/mnt/store/state"
printf '{"nodeID":"n-1"}' >"$p/mnt/store/state/state.json"
: >"$p/mnt/store/state/id.key"
printf 'ciphertext' >"$p/mnt/store/state/stray.blob"
envfile "$p" "RELAYIUM_NODE_STORAGE_DIR=$p/mnt/store" \
  "RELAYIUM_NODE_STATE_DIR=$p/mnt/store/state"
run "$p" RELAYIUM_NODE_FORCE=1
rc=$?
check_rc "state dir inside storage: keeps the unrecognised file" "$rc" 2
assert_present "$p/mnt/store/state/stray.blob" "state dir inside storage: stray file survives"
assert_present "$p/mnt/store/blob-1" "state dir inside storage: blobs survive"
assert_gone "$p/mnt/store/state/state.json" "state dir inside storage: state.json removed"

# --- 27. the DNS reminder comes BEFORE the token that manages it is deleted -
p=$(newtree c27)
envfile "$p" "RELAYIUM_NODE_STORAGE_DIR=" \
  "RELAYIUM_NODE_DOWNLOAD_URL=n1.example.com" \
  "RELAYIUM_NODE_CF_ZONE=example.com"
run "$p"
rc=$?
check_rc "DNS reminder: uninstalls" "$rc" 0
assert_gone "$p/etc/relayium-node" "DNS reminder: conf dir removed"
dnsline=$(grep -n "n1.example.com" "$TMPROOT/out" | head -n1 | cut -d: -f1)
doneline=$(grep -n "relayium-node uninstalled" "$TMPROOT/out" | head -n1 | cut -d: -f1)
if [ -n "$dnsline" ] && [ -n "$doneline" ] && [ "$dnsline" -lt "$doneline" ]; then
  ok "DNS reminder: printed before the conf dir is deleted"
else
  bad "DNS reminder: printed before the conf dir is deleted"
fi
if grep -q "example.com" "$TMPROOT/out"; then
  ok "DNS reminder: names the Cloudflare zone"
else
  bad "DNS reminder: names the Cloudflare zone"
fi

# --- 28. a purge that cannot delete the storage directory -------------------
# Under `set -e` the failing rm killed the script with no message at all, after
# the node had already been deregistered and the units deleted: a machine that
# is neither a node nor cleaned up. It must finish the job and say so.
p=$(newtree c28)
blobs "$p/mnt/nuke-fail" 2
envfile "$p" "RELAYIUM_NODE_STORAGE_DIR=$p/mnt/nuke-fail"
RUNPATH="$STUBRMFAIL:$STUB:$BASEPATH"
run "$p" RELAYIUM_NODE_FORCE=1 RELAYIUM_NODE_PURGE_STORAGE=1
rc=$?
RUNPATH="$STUB:$BASEPATH"
check_rc "purge fails: reports instead of dying silently" "$rc" 2
if grep -q "could not delete the storage directory" "$TMPROOT/out"; then
  ok "purge fails: says so"
else
  bad "purge fails: says so"
fi
assert_gone "$p/var/lib/relayium-node" "purge fails: the rest of the uninstall finished"
assert_gone "$p/etc/relayium-node" "purge fails: conf dir still removed"

[ "$fail" = 0 ] && echo "ALL TESTS PASSED" || echo "SOME TESTS FAILED"
exit "$fail"
