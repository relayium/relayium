#!/bin/sh
# Relayium relay-node uninstaller.
#   curl -fsSL https://relayium.com/uninstall-node.sh | sudo sh
#
# THIS IS NOT THE UPGRADE PATH. Upgrades replace the binary in place and never
# touch your data — the node updates itself (relayium-node-update.timer), or you
# can run `relayium-node update` by hand. If an update went wrong, the fix is to
# re-run the INSTALLER; uninstalling would destroy files for no reason at all.
# Uninstall is for "this machine is no longer a node", which is permanent.
#
# Uninstalling a STORAGE node destroys the files on it. Every stored file binds
# to exactly one node and there are no replicas, so this script refuses to run
# while the node still holds live files. The safe sequence is:
#   1. mark the node "draining" in the admin panel — no new files land on it;
#   2. wait until the panel says it is safe to uninstall (its last file has
#      expired — up to 14 days);
#   3. run this script.
#
# Optional (env vars do NOT survive a plain `| sudo sh`, so pass them through
# sudo itself:  curl -fsSL … | sudo env RELAYIUM_NODE_FORCE=1 sh):
#   RELAYIUM_NODE_PURGE_STORAGE=1  also delete the blob storage directory
#                                  (off by default: it holds other people's files)
#   RELAYIUM_NODE_FORCE=1          uninstall even though the node still holds files.
#                                  FORCE does NOT delete the storage directory —
#                                  only RELAYIUM_NODE_PURGE_STORAGE=1 does.
#   RELAYIUM_NODE_ASSUME_NO_STORAGE=1
#                                  "this node stores nothing" — the ONLY way past
#                                  the refusal that fires when the blob directory
#                                  cannot be located. Deliberately a different
#                                  variable from FORCE: FORCE preserves storage,
#                                  this one lets the state dir be deleted whole.
#   RELAYIUM_NODE_STORAGE_DIR      where the blobs live, when this script cannot
#                                  read it from /etc/relayium-node/env (set it to
#                                  the empty string to declare "no storage here")
#   RELAYIUM_INSTALL_DIR           where the binary was installed (default /usr/local/bin)
#   RELAYIUM_NODE_PREFIX           path prefix for every system path, for testing
set -eu

say() { echo "relayium-node-uninstall: $*"; }
err() { echo "relayium-node-uninstall: $*" >&2; exit 1; }

# PREFIX exists so this script can be exercised against a scratch directory.
# The root requirement comes from the files being root-owned under /; a prefixed
# run never touches anything under / and therefore does not need root.
PREFIX="${RELAYIUM_NODE_PREFIX:-}"
if [ -z "$PREFIX" ] && [ "$(id -u)" != "0" ]; then
  err "run as root (sudo)"
fi

INSTALL_DIR="${RELAYIUM_INSTALL_DIR:-/usr/local/bin}"
CONF_DIR="${PREFIX}/etc/relayium-node"
ENV_FILE="${CONF_DIR}/env"
UNIT_DIR="${PREFIX}/etc/systemd/system"
BIN="${PREFIX}${INSTALL_DIR}/relayium-node"

# Read one KEY=value out of the systemd EnvironmentFile. Deliberately parsed
# rather than sourced: `.` on a config file would execute whatever is in it and
# would also overwrite the caller's own RELAYIUM_* variables.
#
# Surrounding whitespace is trimmed. A hand-edited env file with a trailing
# space after the path used to yield a value that failed every `-d` test, which
# in the storage case read as "this node has no blobs" — the single most
# dangerous way for this script to be wrong.
#
# Matched surrounding quotes are stripped too. systemd's EnvironmentFile accepts
# them and REQUIRES them for a path containing a space, so a perfectly valid
# `RELAYIUM_NODE_STORAGE_DIR="/var/lib/relayium-node/blobs"` used to yield a
# literal `"…"` that failed every `-d` test — again reading as "no blobs here".
unquote() {
  v=$1
  case $v in
    '"'*'"') v=${v#\"} ; v=${v%\"} ;;
    "'"*"'") v=${v#\'} ; v=${v%\'} ;;
  esac
  printf '%s' "$v"
}
envval() {
  [ -f "$ENV_FILE" ] || return 0
  v=$(sed -n "s/^$1=//p" "$ENV_FILE" | head -n1 |
    sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')
  unquote "$v"
}

# envhas reports whether the env file mentions KEY at all — the difference
# between "this node has no storage" (key present and empty, what the installer
# writes for a relay-only node) and "we have no idea" (no key, no env file).
envhas() {
  [ -f "$ENV_FILE" ] || return 1
  grep -q "^$1=" "$ENV_FILE"
}

# Collapse duplicate slashes and drop trailing ones, so /var/lib/x, /var/lib/x/
# and //var//lib//x are the same path to every comparison below. "/" stays "/".
# Collapsing is not cosmetic: the reject list below matches literal spellings, and
# `//var` is `/var` to the kernel but not to `case`.
normpath() {
  p=$(printf '%s' "$1" | sed -e 's,//*,/,g' -e 's,\(.\)/*$,\1,')
  [ -n "$p" ] || p=/ # the input was nothing but slashes
  printf '%s' "$p"
}

# Resolve a directory to its real, symlink-free path. Prints nothing and returns
# 1 when the argument does not resolve to a directory at all. Every nesting and
# equality test below runs on resolved paths: a blob directory symlinked onto the
# big disk is the standard layout, and comparing the link's spelling instead of
# its target is how "storage lives inside the state dir" gets answered wrongly.
realdir() {
  (CDPATH='' cd -P -- "$1" 2>/dev/null && pwd -P) || return 1
}

# Every path this script hands to `rm -rf` goes through here first, before
# anything at all has been removed: a typo'd RELAYIUM_NODE_STORAGE_DIR and a
# hand-edited RELAYIUM_NODE_STATE_DIR both reach one. No blob or state directory
# is ever a system root, so refusing costs a correct run nothing.
#
# A `.` or `..` segment is rejected rather than resolved: /var/lib/. is /var/lib
# spelled differently, and the reject list only recognises one spelling.
refuse_dangerous_path() {
  case "/$1/" in
    */./* | */../*) err "refusing to delete $1 ($2): the path contains a '.' or '..' segment" ;;
  esac
  case "$1" in
    / | /bin | /boot | /dev | /etc | /home | /lib | /lib64 | /opt | /proc | /root | \
      /run | /sbin | /srv | /sys | /tmp | /usr | /usr/local | /var | /var/lib | /var/log)
      err "refusing to delete $1 ($2): that is a system directory"
      ;;
  esac
}

# STORAGE_DIR is the one value whose absence is dangerous, so unlike the rest it
# is also readable from the environment — an operator who knows where the blobs
# are can say so when the env file is gone, was never written (the installer's
# non-root / no-systemd path writes none), or lives somewhere else entirely.
# The environment wins over the file. storage_known=no means "unaccounted for",
# which is a refusal below, never a silent delete.
storage_known=no
STORAGE_DIR=""
if [ -n "${RELAYIUM_NODE_STORAGE_DIR+set}" ]; then
  STORAGE_DIR=$(printf '%s' "$RELAYIUM_NODE_STORAGE_DIR" |
    sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')
  storage_known=yes
elif envhas RELAYIUM_NODE_STORAGE_DIR; then
  STORAGE_DIR=$(envval RELAYIUM_NODE_STORAGE_DIR)
  storage_known=yes
fi
CENTRAL_URL=$(envval RELAYIUM_CENTRAL_URL)
NODE_TOKEN=$(envval RELAYIUM_NODE_TOKEN)
DOWNLOAD_URL=$(envval RELAYIUM_NODE_DOWNLOAD_URL)
STATE_DIR=$(envval RELAYIUM_NODE_STATE_DIR)
[ -n "$STATE_DIR" ] || STATE_DIR="${PREFIX}/var/lib/relayium-node"
STATE_DIR=$(normpath "$STATE_DIR")
[ -z "$STORAGE_DIR" ] || STORAGE_DIR=$(normpath "$STORAGE_DIR")

# RELAYIUM_NODE_PURGE_STORAGE=1 means `rm -rf "$STORAGE_DIR"`, and the state dir
# is `rm -rf`'d unconditionally further down, so both are vetted here — before
# anything at all has been removed.
if [ "${RELAYIUM_NODE_PURGE_STORAGE:-}" = "1" ] && [ -n "$STORAGE_DIR" ]; then
  refuse_dangerous_path "$STORAGE_DIR" "storage directory"
fi
refuse_dangerous_path "$STATE_DIR" "state directory"

# Resolve both paths once, here, and compare only the resolved forms from now on.
# STATE_REAL falls back to the declared path when the directory is already gone —
# there is then nothing to nest inside it, so no comparison can be wrong.
STATE_REAL=$(realdir "$STATE_DIR") || STATE_REAL="$STATE_DIR"
[ "$STATE_REAL" = "$STATE_DIR" ] || refuse_dangerous_path "$STATE_REAL" "state directory"

# A declared storage directory that does not resolve is UNACCOUNTED FOR, not
# empty. Treating it as safe is how a quoted env-file value or a one-character
# typo used to end in `rm -rf "$STATE_DIR"` with the blobs inside it, exit 0 and
# no message at all. It refuses instead, and only the explicit
# RELAYIUM_NODE_ASSUME_NO_STORAGE=1 gets past it.
STORAGE_REAL=""
if [ -n "$STORAGE_DIR" ]; then
  if STORAGE_REAL=$(realdir "$STORAGE_DIR"); then
    if [ "${RELAYIUM_NODE_PURGE_STORAGE:-}" = "1" ] && [ "$STORAGE_REAL" != "$STORAGE_DIR" ]; then
      refuse_dangerous_path "$STORAGE_REAL" "storage directory"
    fi
  elif [ "${RELAYIUM_NODE_ASSUME_NO_STORAGE:-}" = "1" ]; then
    say "WARNING: declared storage directory ${STORAGE_DIR} does not exist and"
    say "  RELAYIUM_NODE_ASSUME_NO_STORAGE=1 — continuing as a node with no storage."
    STORAGE_DIR=""
    STORAGE_REAL=""
  else
    {
      echo "The storage directory this node declares does not exist, so nothing was removed."
      echo ""
      echo "Declared: ${STORAGE_DIR}"
      echo ""
      echo "That is not the same as 'this node stores nothing' — it usually means a"
      echo "typo, a stale path, or quoting in ${ENV_FILE}. The blobs may still be"
      echo "somewhere on this machine, and continuing could delete them: every stored"
      echo "file binds to exactly one node and Relayium keeps no replicas."
      echo ""
      echo "Find where the blobs actually live on THIS machine and pass that path:"
      echo "  curl -fsSL https://relayium.com/uninstall-node.sh |"
      echo "    sudo env RELAYIUM_NODE_STORAGE_DIR=<your blob directory> sh"
      echo ""
      echo "Only if you are certain this node never stored anything:"
      echo "  curl -fsSL https://relayium.com/uninstall-node.sh |"
      echo "    sudo env RELAYIUM_NODE_ASSUME_NO_STORAGE=1 sh"
      echo "(that is NOT RELAYIUM_NODE_FORCE, which preserves storage — this one"
      echo " permits deleting ${STATE_DIR} whole.)"
    } >&2
    exit 1
  fi
fi

# ---------------------------------------------------------------------------
# Refuse when we cannot tell where the blobs are. The default state directory is
# also the default place the "add your own node" panel puts blobs, so deleting
# the state directory with storage unaccounted for is exactly the accident this
# script exists to prevent — and it would happen with no message at all.
# ---------------------------------------------------------------------------
#
# The refusal deliberately does NOT suggest a path. It used to hand over a
# copy-pasteable `RELAYIUM_NODE_STORAGE_DIR=/var/lib/relayium-node/blobs`, which
# is a GUESS: an operator whose blobs live elsewhere pastes it, the guessed path
# does not exist, and the refusal itself becomes the instruction that destroys
# the files. Ask for their path; never propose one.
if [ "$storage_known" = no ]; then
  if [ "${RELAYIUM_NODE_ASSUME_NO_STORAGE:-}" != "1" ]; then
    {
      echo "Cannot tell whether this node stores files, so nothing was removed."
      echo ""
      echo "${ENV_FILE} does not exist or does not mention"
      echo "RELAYIUM_NODE_STORAGE_DIR, and stored blobs commonly live INSIDE the"
      echo "state directory (${STATE_DIR})."
      echo "Deleting that blindly would destroy other people's files: every stored"
      echo "file binds to exactly one node and Relayium keeps no replicas."
      echo ""
      echo "Find where the blobs actually live on THIS machine — the install"
      echo "command you used names it — and pass that path, not one from this"
      echo "message:"
      echo "  curl -fsSL https://relayium.com/uninstall-node.sh |"
      echo "    sudo env RELAYIUM_NODE_STORAGE_DIR=<your blob directory> sh"
      echo ""
      echo "If this node never stored anything (relay only), say so explicitly:"
      echo "  curl -fsSL https://relayium.com/uninstall-node.sh |"
      echo "    sudo env RELAYIUM_NODE_ASSUME_NO_STORAGE=1 sh"
      echo ""
      echo "That is NOT RELAYIUM_NODE_FORCE. FORCE means 'uninstall although this"
      echo "node still holds files' and PRESERVES the storage directory;"
      echo "RELAYIUM_NODE_ASSUME_NO_STORAGE means 'there are no blobs here' and"
      echo "permits deleting ${STATE_DIR} whole."
    } >&2
    exit 1
  fi
  say "WARNING: storage directory unknown and RELAYIUM_NODE_ASSUME_NO_STORAGE=1 —"
  say "  ${STATE_DIR} and everything under it will be deleted."
fi

# ---------------------------------------------------------------------------
# Refuse while the node still holds files. Nothing above this point deletes or
# changes anything, so a refusal leaves the machine exactly as it was.
# ---------------------------------------------------------------------------

# The node's own bookkeeping files, which sit in the storage directory whenever
# storage and state are the same directory. They are not stored files and must
# never be counted as a reason to refuse (nor reported as "left untouched").
is_state_file() {
  case $1 in
    "${STATE_REAL}/state.json" | "${STATE_REAL}/id.key" | "${STATE_REAL}/id.crt" | \
      "${STATE_REAL}/last-heartbeat" | "${STATE_REAL}/pending-update-result" | \
      "${STATE_REAL}/failed-versions") return 0 ;;
    "${STATE_REAL}"/state.json.tmp* | "${STATE_REAL}"/last-heartbeat.tmp*) return 0 ;;
  esac
  return 1
}

# `find -L`, and on the RESOLVED path. Without -L, find refuses to descend a
# symlinked blob directory — the standard "point the blob store at the big disk"
# layout — and reported zero files for a node holding thousands, which read as
# "empty storage" and took the delete-everything branch.
stored_files=0
if [ -n "$STORAGE_REAL" ]; then
  stored_files=$(find -L "$STORAGE_REAL" -type f 2>/dev/null | {
    n=0
    while IFS= read -r f; do
      is_state_file "$f" || n=$((n + 1))
    done
    echo "$n"
  })
fi
if [ "$stored_files" -gt 0 ] && [ "${RELAYIUM_NODE_FORCE:-}" != "1" ]; then
  {
    echo "This node still holds ${stored_files} stored file(s) in ${STORAGE_DIR}."
    echo ""
    echo "Those files exist ONLY here — every stored file binds to exactly one node"
    echo "and Relayium keeps no replicas. Uninstalling now makes them PERMANENTLY"
    echo "unreachable for the people who uploaded them. Nothing can bring them back."
    echo ""
    echo "Drain first, then wait:"
    echo "  1. mark this node 'draining' in the admin panel — new uploads stop"
    echo "     landing on it immediately, and the files it already holds keep"
    echo "     downloading normally;"
    echo "  2. wait until the panel shows it is safe to uninstall (the last file"
    echo "     on it has expired — up to 14 days);"
    echo "  3. run this script again."
    echo ""
    echo "If you are here because an update broke: do NOT uninstall. Re-run the"
    echo "installer — upgrades never touch stored data."
    echo ""
    echo "To destroy those files and uninstall anyway (note the 'sudo env' — a"
    echo "variable set in front of curl does not survive the pipe into sudo):"
    echo "  curl -fsSL https://relayium.com/uninstall-node.sh |"
    echo "    sudo env RELAYIUM_NODE_FORCE=1 sh"
    echo ""
    echo "FORCE keeps the storage directory itself — the blobs stay on disk, just"
    echo "unreachable. Add RELAYIUM_NODE_PURGE_STORAGE=1 to delete them as well."
  } >&2
  exit 1
fi

# ---------------------------------------------------------------------------
# Tell central we are going away, so it stops handing this node out and the
# admin list does not accumulate permanently-offline ghosts. Strictly best
# effort: an unreachable central must never leave a half-uninstalled machine.
# ---------------------------------------------------------------------------
NODE_ID=""
if [ -f "${STATE_DIR}/state.json" ]; then
  NODE_ID=$(sed -n 's/.*"nodeID"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "${STATE_DIR}/state.json" | head -n1)
fi
if [ -n "$CENTRAL_URL" ] && [ -n "$NODE_TOKEN" ] && [ -n "$NODE_ID" ] && command -v curl >/dev/null 2>&1; then
  if curl -fsS --max-time 15 -X POST "${CENTRAL_URL}/api/nodes/deregister" \
      -H "Authorization: Bearer ${NODE_TOKEN}" \
      -H "Content-Type: application/json" \
      -d "{\"nodeID\":\"${NODE_ID}\"}" >/dev/null 2>&1; then
    say "deregistered ${NODE_ID} from ${CENTRAL_URL}"
  else
    echo "relayium-node-uninstall: could not reach central to deregister — continuing." >&2
    echo "relayium-node-uninstall: delete node ${NODE_ID} from the admin panel by hand." >&2
  fi
else
  say "no central URL, token or node id on disk — skipping deregistration"
fi

# ---------------------------------------------------------------------------
# systemd units: relayium-node.service plus the self-update pair the installer
# adds when auto-update is on. Absent systemd (a hand-run node) is normal, not
# an error.
# ---------------------------------------------------------------------------
if command -v systemctl >/dev/null 2>&1; then
  for unit in relayium-node.service relayium-node-update.timer relayium-node-update.service; do
    systemctl disable --now "$unit" >/dev/null 2>&1 || true
  done
  systemctl daemon-reload >/dev/null 2>&1 || true
fi
rm -f "${UNIT_DIR}/relayium-node.service" \
      "${UNIT_DIR}/relayium-node-update.service" \
      "${UNIT_DIR}/relayium-node-update.timer"
# `systemctl disable` normally removes these; do it explicitly so a machine
# whose systemd is already broken (or absent) is not left with dangling enable
# symlinks that resurrect the unit on the next boot.
rm -f "${UNIT_DIR}/multi-user.target.wants/relayium-node.service" \
      "${UNIT_DIR}/timers.target.wants/relayium-node-update.timer"
if command -v systemctl >/dev/null 2>&1; then
  systemctl daemon-reload >/dev/null 2>&1 || true
fi

# The binary, plus the updater's rollback copy. The .prev matters: the updater
# refuses to start while a stale one is lying around, so leaving it behind would
# break a later reinstall on this same machine.
# (.prev.tmp is the half-written rollback copy an interrupted update leaves.)
rm -f "$BIN" "${BIN}.prev" "${BIN}.prev.tmp"

rm -rf "$CONF_DIR"

# ---------------------------------------------------------------------------
# The storage directory is OTHER PEOPLE'S FILES. Deleting it is opt-in, always.
# ---------------------------------------------------------------------------
if [ -n "$STORAGE_REAL" ]; then
  if [ "${RELAYIUM_NODE_PURGE_STORAGE:-}" = "1" ]; then
    # Purge the resolved directory: `rm -rf` on a symlink removes the link and
    # leaves every blob behind, which is the opposite of what was asked for.
    rm -rf "$STORAGE_REAL"
    [ "$STORAGE_REAL" = "$STORAGE_DIR" ] || rm -f "$STORAGE_DIR"
    say "purged storage directory ${STORAGE_DIR}"
  elif [ "$stored_files" -gt 0 ]; then
    size=$(du -sh "$STORAGE_DIR" 2>/dev/null | awk '{print $1}')
    say "left ${stored_files} file(s) (${size:-unknown size}) in ${STORAGE_DIR} untouched."
    say "  they are encrypted blobs and are no longer reachable through Relayium;"
    say "  delete them yourself, or re-run with RELAYIUM_NODE_PURGE_STORAGE=1."
  else
    say "left the empty storage directory ${STORAGE_DIR} in place (RELAYIUM_NODE_PURGE_STORAGE=1 to delete)"
  fi
fi

# ---------------------------------------------------------------------------
# State. Holds state.json (this node's identity), id.key/id.crt, last-heartbeat,
# and the root-written pending-update-result and failed-versions — per-machine
# bookkeeping, none of it user data.
#
# The nested case is not hypothetical: the "add your own node" panel hands out an
# install command with RELAYIUM_NODE_STORAGE_DIR=/var/lib/relayium-node/blobs,
# i.e. the blobs live INSIDE the state dir. An unconditional `rm -rf "$STATE_DIR"`
# there would delete other people's files behind the operator's back, with
# RELAYIUM_NODE_PURGE_STORAGE unset and no message — exactly the thing this
# script exists to make impossible. So when the storage directory survived above
# and sits inside the state dir — or IS the state dir, which an operator who
# dropped the /blobs suffix gets — remove the state files by name and leave the
# rest of the tree standing. Both paths were normalised AND resolved through
# their symlinks, so neither a trailing slash nor a blob directory symlinked
# onto another disk can change which branch a machine takes.
# ---------------------------------------------------------------------------
nested_storage=no
if [ -n "$STORAGE_REAL" ] && [ "${RELAYIUM_NODE_PURGE_STORAGE:-}" != "1" ]; then
  case "$STORAGE_REAL" in
    "$STATE_REAL" | "$STATE_REAL"/*) nested_storage=yes ;;
  esac
fi
if [ "$nested_storage" = yes ]; then
  # The .tmp siblings matter: state.json and last-heartbeat are written via a
  # temp file next to them, so a node killed mid-write leaves one behind and the
  # state dir would not actually be empty of node state.
  rm -f "${STATE_DIR}/state.json" "${STATE_DIR}/id.key" "${STATE_DIR}/id.crt" \
    "${STATE_DIR}/last-heartbeat" "${STATE_DIR}/pending-update-result" \
    "${STATE_DIR}/failed-versions"
  rm -f "${STATE_DIR}"/state.json.tmp* "${STATE_DIR}"/last-heartbeat.tmp*
  if [ "$STORAGE_REAL" = "$STATE_REAL" ]; then
    say "kept ${STATE_DIR} — it IS the storage directory (removed only the node's own state files)"
  else
    say "kept ${STATE_DIR} — the storage directory lives inside it (removed only the node's own state files)"
  fi
else
  # Remove the resolved directory, then the symlink if the state dir was one:
  # `rm -rf` on a symlink deletes only the link and leaves the state behind.
  rm -rf "$STATE_REAL"
  [ "$STATE_REAL" = "$STATE_DIR" ] || rm -f "$STATE_DIR"
fi

# The service account the installer created. Best effort: a userdel that fails
# (processes still running, no shadow tools) must not fail the uninstall.
if command -v userdel >/dev/null 2>&1 && id relayium-node >/dev/null 2>&1; then
  userdel relayium-node >/dev/null 2>&1 || true
fi
if command -v groupdel >/dev/null 2>&1; then
  groupdel relayium-node >/dev/null 2>&1 || true
fi

say "relayium-node uninstalled."
if [ -n "$DOWNLOAD_URL" ]; then
  say "note: the DNS record for ${DOWNLOAD_URL} still points here — remove it in Cloudflare."
fi
