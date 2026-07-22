#!/bin/sh
# Relayium relay-node uninstaller.
#   curl -fsSL https://relayium.com/uninstall-node.sh | sudo sh
#
# THIS IS NOT THE UPGRADE PATH. Upgrades replace the binary in place and never
# touch your data — the node updates itself (relayium-node-update.timer), or you
# can run `relayium-node update` by hand. If an update went wrong, the fix is to
# re-run the INSTALLER with the SAME options you originally used (in particular
# RELAYIUM_NODE_STORAGE_DIR: the installer rewrites /etc/relayium-node/env from
# its arguments, so omitting it turns a storage node's configuration into a
# relay-only one). Uninstalling would destroy files for no reason at all.
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
# THE SAFETY MODEL IS AN ALLOWLIST. This script deletes, by name, only the files
# it knows the installer and the node create. Directories are then removed with
# `rmdir`, which refuses to touch a directory that still holds anything else.
# Nothing here ever runs `rm -rf` on a directory whose contents it has not
# accounted for, so a wrong idea of where the blobs live — a stale env file, a
# typo, a moved storage directory, a layout this script has never heard of —
# leaves those files sitting on disk and gets REPORTED, instead of deleted.
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
#                                  variable from FORCE. It still does not permit
#                                  deleting anything unrecognised: a state
#                                  directory holding unknown files is kept and
#                                  reported either way.
#   RELAYIUM_NODE_STORAGE_DIR      where the blobs live, when this script cannot
#                                  read it from /etc/relayium-node/env (set it to
#                                  the empty string to declare "no storage here")
#   RELAYIUM_INSTALL_DIR           where the binary was installed. Normally read
#                                  from RELAYIUM_NODE_BIN in the env file; this
#                                  overrides it (default /usr/local/bin).
#   RELAYIUM_NODE_PREFIX           path prefix for every system path, for testing
set -eu

say() { echo "relayium-node-uninstall: $*"; }
err() { echo "relayium-node-uninstall: $*" >&2; exit 1; }

# Set when something was left behind or could not be removed. The run still
# finishes — a half-uninstalled machine is worse than a fully uninstalled one —
# but the exit status says so, so an operator running this from a script does
# not read "left your blobs alone" as "there is nothing more to do".
exit_code=0

# PREFIX exists so this script can be exercised against a scratch directory.
# The root requirement comes from the files being root-owned under /; a prefixed
# run never touches anything under / and therefore does not need root.
PREFIX="${RELAYIUM_NODE_PREFIX:-}"
if [ -z "$PREFIX" ] && [ "$(id -u)" != "0" ]; then
  err "run as root (sudo)"
fi

CONF_DIR="${PREFIX}/etc/relayium-node"
ENV_FILE="${CONF_DIR}/env"
UNIT_DIR="${PREFIX}/etc/systemd/system"

# Read one KEY=value out of the systemd EnvironmentFile. Deliberately parsed
# rather than sourced: `.` on a config file would execute whatever is in it and
# would also overwrite the caller's own RELAYIUM_* variables.
#
# LAST assignment wins, exactly as systemd's EnvironmentFile does. It used to
# take the first, so an operator who corrected a path by appending a line — the
# obvious way to edit the file, and what the node itself then obeyed — made this
# script read a directory the node had not used for months.
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
trim() {
  printf '%s' "$1" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//'
}
envval() {
  [ -f "$ENV_FILE" ] || return 0
  v=$(sed -n "s/^$1=//p" "$ENV_FILE" | tail -n1)
  unquote "$(trim "$v")"
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

# The last line of defence for the only path still handed to `rm -rf`, the
# EXPLICITLY purged storage directory. Everything else is removed by allowlist,
# so a typo there costs nothing; here it would cost a filesystem.
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

# ---------------------------------------------------------------------------
# Where things are.
# ---------------------------------------------------------------------------
#
# STORAGE_DIR is the one value whose absence is dangerous, so unlike the rest it
# is also readable from the environment — an operator who knows where the blobs
# are can say so when the env file is gone, was never written (the installer's
# non-root / no-systemd path writes none), or lives somewhere else entirely.
# The environment wins over the file, but a DISAGREEMENT is shouted about: both
# refusal messages below tell the operator to supply a path, and an operator who
# supplies the wrong-but-existing one would otherwise silently override a
# perfectly correct value sitting in the env file.
storage_known=no
STORAGE_DIR=""
if [ -n "${RELAYIUM_NODE_STORAGE_DIR+set}" ]; then
  STORAGE_DIR=$(trim "$RELAYIUM_NODE_STORAGE_DIR")
  storage_known=yes
  if envhas RELAYIUM_NODE_STORAGE_DIR; then
    file_storage=$(envval RELAYIUM_NODE_STORAGE_DIR)
    a=$STORAGE_DIR; [ -z "$a" ] || a=$(normpath "$a")
    b=$file_storage; [ -z "$b" ] || b=$(normpath "$b")
    if [ "$a" != "$b" ]; then
      {
        echo "relayium-node-uninstall: WARNING: the storage directory you passed and the one"
        echo "relayium-node-uninstall:   in ${ENV_FILE} DISAGREE."
        echo "relayium-node-uninstall:     you passed: ${STORAGE_DIR:-<empty: no storage>}"
        echo "relayium-node-uninstall:     env file:   ${file_storage:-<empty: no storage>}"
        echo "relayium-node-uninstall:   Using the one you passed. The env file is what the node"
        echo "relayium-node-uninstall:   itself was configured with, so if it names a real"
        echo "relayium-node-uninstall:   directory, that is where the blobs are — stop and check."
      } >&2
    fi
  fi
elif envhas RELAYIUM_NODE_STORAGE_DIR; then
  STORAGE_DIR=$(envval RELAYIUM_NODE_STORAGE_DIR)
  storage_known=yes
fi
CENTRAL_URL=$(envval RELAYIUM_CENTRAL_URL)
NODE_TOKEN=$(envval RELAYIUM_NODE_TOKEN)
DOWNLOAD_URL=$(envval RELAYIUM_NODE_DOWNLOAD_URL)
CF_ZONE=$(envval RELAYIUM_NODE_CF_ZONE)
STATE_DIR=$(envval RELAYIUM_NODE_STATE_DIR)
[ -n "$STATE_DIR" ] || STATE_DIR="${PREFIX}/var/lib/relayium-node"
STATE_DIR=$(normpath "$STATE_DIR")
[ -z "$STORAGE_DIR" ] || STORAGE_DIR=$(normpath "$STORAGE_DIR")

# The binary's location comes from the env file the installer wrote, because a
# node installed with RELAYIUM_INSTALL_DIR=/opt/bin used to be reported as fully
# uninstalled while relayium-node, .prev and .prev.tmp stayed on disk — and a
# leftover .prev makes the next install refuse to start.
if [ -n "${RELAYIUM_INSTALL_DIR:-}" ]; then
  BIN="${PREFIX}${RELAYIUM_INSTALL_DIR}/relayium-node"
else
  env_bin=$(envval RELAYIUM_NODE_BIN)
  if [ -n "$env_bin" ]; then
    BIN="${PREFIX}$(normpath "$env_bin")"
  else
    BIN="${PREFIX}/usr/local/bin/relayium-node"
  fi
fi

# RELAYIUM_NODE_PURGE_STORAGE=1 means `rm -rf "$STORAGE_DIR"` — vetted here,
# before anything at all has been removed. The state and configuration
# directories need no such list: they are emptied by allowlist and then rmdir'd,
# which cannot destroy anything this script did not put there. They are checked
# anyway, because a `.`/`..` spelling would defeat the nesting comparisons.
if [ "${RELAYIUM_NODE_PURGE_STORAGE:-}" = "1" ] && [ -n "$STORAGE_DIR" ]; then
  refuse_dangerous_path "$STORAGE_DIR" "storage directory"
fi
refuse_dangerous_path "$STATE_DIR" "state directory"
refuse_dangerous_path "$(normpath "$CONF_DIR")" "configuration directory"

# Resolve both paths once, here, and compare only the resolved forms from now on.
# STATE_REAL falls back to the declared path when the directory is already gone —
# there is then nothing to nest inside it, so no comparison can be wrong.
STATE_REAL=$(realdir "$STATE_DIR") || STATE_REAL="$STATE_DIR"
[ "$STATE_REAL" = "$STATE_DIR" ] || refuse_dangerous_path "$STATE_REAL" "state directory"
CONF_REAL=$(realdir "$CONF_DIR") || CONF_REAL=$(normpath "$CONF_DIR")

# A declared storage directory that does not resolve is UNACCOUNTED FOR, not
# empty. Treating it as safe is how a quoted env-file value or a one-character
# typo used to end in `rm -rf "$STATE_DIR"` with the blobs inside it, exit 0 and
# no message at all. It refuses instead, and only the explicit
# RELAYIUM_NODE_ASSUME_NO_STORAGE=1 gets past it — which is now merely a
# statement about the storage directory, not a licence to delete unknown files.
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
      echo "(that is NOT RELAYIUM_NODE_FORCE, which preserves storage.)"
    } >&2
    exit 1
  fi
fi

# ---------------------------------------------------------------------------
# Refuse when we cannot tell where the blobs are. The default state directory is
# also the default place the "add your own node" panel puts blobs, so proceeding
# with storage unaccounted for is exactly the accident this script exists to
# prevent. The allowlist below would keep the blobs even so — but silently
# leaving a directory nobody understands is not an uninstall, and the operator
# needs to be told before anything happens rather than after.
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
      echo "Continuing blind is how other people's files get orphaned: every stored"
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
      echo "RELAYIUM_NODE_ASSUME_NO_STORAGE means 'there are no blobs here'."
    } >&2
    exit 1
  fi
  say "WARNING: storage directory unknown and RELAYIUM_NODE_ASSUME_NO_STORAGE=1 —"
  say "  continuing. ${STATE_DIR} will be emptied of the node's own state files;"
  say "  anything else in it is kept and reported."
fi

# ---------------------------------------------------------------------------
# Refuse while the node still holds files. Nothing above this point deletes or
# changes anything, so a refusal leaves the machine exactly as it was.
# ---------------------------------------------------------------------------

# THE ALLOWLIST. Exactly the files the node writes into its state directory —
# and, when storage and state are the same directory, into the storage
# directory. They are not stored files (so they must never be counted as a
# reason to refuse, nor reported as "left untouched"), and they are the ONLY
# things this script deletes there. Anything not on this list is, by definition,
# unaccounted for: it is kept, and reported.
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
# symlinked directory — the standard "point the blob store at the big disk"
# layout, whether the storage root itself or a shard inside it is the link — and
# reported zero files for a node holding thousands, which read as "empty
# storage" and took the delete-everything branch.
#
# find's EXIT STATUS is captured. It used to be discarded along with its stderr,
# so a storage directory that is searchable but not readable (chmod 111, or NFS
# with root_squash), or a find that is not there at all, counted zero files with
# no message — and zero is precisely the answer that unlocks the deletion. Its
# stderr is deliberately NOT swallowed either: the reason is the useful part.
stored_files=0
storage_counted=yes
if [ -n "$STORAGE_REAL" ]; then
  scan_rc=0
  scan=$(find -L "$STORAGE_REAL" -type f) || scan_rc=$?
  if [ "$scan_rc" != 0 ]; then
    storage_counted=no
  else
    stored_files=$(printf '%s\n' "$scan" | {
      n=0
      while IFS= read -r f; do
        [ -n "$f" ] || continue
        is_state_file "$f" || n=$((n + 1))
      done
      echo "$n"
    })
  fi
fi

if [ "$storage_counted" = no ]; then
  if [ "${RELAYIUM_NODE_FORCE:-}" != "1" ]; then
    {
      echo "Could not list the storage directory, so nothing was removed."
      echo ""
      echo "Storage: ${STORAGE_DIR}"
      echo "(find failed — the reason is printed above this message: an unreadable"
      echo "directory, a squashed NFS mount, or no usable find on this machine.)"
      echo ""
      echo "'Could not count' is NOT 'holds nothing'. This node may still hold live"
      echo "files, and they exist only here — every stored file binds to exactly one"
      echo "node and Relayium keeps no replicas."
      echo ""
      echo "Fix the reason and run this script again. If you have checked by hand and"
      echo "want to uninstall regardless (the storage directory is preserved):"
      echo "  curl -fsSL https://relayium.com/uninstall-node.sh |"
      echo "    sudo env RELAYIUM_NODE_FORCE=1 sh"
    } >&2
    exit 1
  fi
  say "WARNING: could not list ${STORAGE_DIR} (reason above) — continuing because"
  say "  RELAYIUM_NODE_FORCE=1. Its contents are treated as UNKNOWN, not as empty."
fi

if [ "$storage_counted" = yes ] && [ "$stored_files" -gt 0 ] &&
  [ "${RELAYIUM_NODE_FORCE:-}" != "1" ]; then
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
    echo "installer with the same options you first used — upgrades never touch"
    echo "stored data."
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
# Removal helpers. Every directory this script removes goes through finish_dir:
# the caller deletes the files it recognises BY NAME, then finish_dir rmdir's
# what is left. rmdir cannot delete a non-empty directory, so an unrecognised
# file does not need to be anticipated to be survived — which is the point.
# Six separate bugs had the same shape ("the script decided the blobs were
# somewhere else, then rm -rf'd the directory they were actually in"); none of
# them can end that way now, whatever made the script wrong.
# ---------------------------------------------------------------------------

# leftovers DIR — every path under DIR that is still there, one per line.
leftovers() {
  find -L "$1" 2>/dev/null | while IFS= read -r e; do
    [ "$e" = "$1" ] || printf '%s\n' "$e"
  done
}

# finish_dir DIR LABEL — remove DIR if the caller emptied it; otherwise say
# exactly what is in the way and leave every bit of it alone. Returns non-zero
# when the directory was kept.
finish_dir() {
  d=$1
  label=$2
  [ -d "$d" ] || return 0
  if rmdir "$d" 2>/dev/null; then
    return 0
  fi
  n=$(leftovers "$d" | {
    c=0
    while IFS= read -r e; do
      [ -n "$e" ] || continue
      c=$((c + 1))
    done
    echo "$c"
  })
  size=$(du -sh "$d" 2>/dev/null | awk '{print $1}')
  say "KEPT ${d} (${label}): it still holds ${n} item(s), ${size:-unknown size},"
  say "  that this uninstaller does not recognise. It removed only the files it"
  say "  created and touched nothing else. If these are stored blobs they are the"
  say "  only copy — every file binds to one node and there are no replicas."
  leftovers "$d" | head -n 5 | while IFS= read -r e; do
    [ -n "$e" ] || continue
    say "    ${e}"
  done
  if [ "$n" -gt 5 ]; then
    say "    … and $((n - 5)) more; see: ls -la ${d}"
  fi
  return 1
}

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

# ---------------------------------------------------------------------------
# The storage directory is OTHER PEOPLE'S FILES. Deleting it is opt-in, always,
# and it is the one thing here removed wholesale rather than by allowlist —
# because "delete the blobs" is precisely what was asked for.
# ---------------------------------------------------------------------------
if [ -n "$STORAGE_REAL" ]; then
  if [ "${RELAYIUM_NODE_PURGE_STORAGE:-}" = "1" ]; then
    # Purge the resolved directory: `rm -rf` on a symlink removes the link and
    # leaves every blob behind, which is the opposite of what was asked for.
    # A failure here must not abort under `set -e`: the units are already gone
    # and the node already deregistered, so dying silently would leave a machine
    # that is neither a node nor cleaned up.
    purge_rc=0
    rm -rf "$STORAGE_REAL" || purge_rc=$?
    if [ "$STORAGE_REAL" != "$STORAGE_DIR" ]; then
      rm -f "$STORAGE_DIR" || purge_rc=$?
    fi
    if [ "$purge_rc" = 0 ]; then
      say "purged storage directory ${STORAGE_DIR}"
    else
      say "WARNING: could not delete the storage directory ${STORAGE_DIR} (rm exited"
      say "  ${purge_rc}). The rest of the uninstall finished; remove it by hand."
      exit_code=2
    fi
  elif [ "$storage_counted" = no ]; then
    say "left ${STORAGE_DIR} untouched — its contents could not be listed."
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
# Those names, and nothing else, are what gets deleted. The directory itself is
# then rmdir'd, which succeeds only if that was genuinely all it held. The nested
# case is not hypothetical: the "add your own node" panel hands out an install
# command with RELAYIUM_NODE_STORAGE_DIR=/var/lib/relayium-node/blobs, i.e. the
# blobs live INSIDE the state dir; an operator who dropped the /blobs suffix has
# them directly in it. The old `rm -rf "$STATE_DIR"` deleted them whenever
# anything at all made the script believe storage was elsewhere or absent —
# a rewritten env file, a wrong path passed on the command line, a moved
# directory. Now it cannot: unrecognised files keep their directory alive.
# ---------------------------------------------------------------------------
# The .tmp siblings matter: state.json and last-heartbeat are written via a temp
# file next to them, so a node killed mid-write leaves one behind and the state
# dir would not actually be empty of node state.
if [ -d "$STATE_REAL" ]; then
  rm -f "${STATE_REAL}/state.json" "${STATE_REAL}/id.key" "${STATE_REAL}/id.crt" \
    "${STATE_REAL}/last-heartbeat" "${STATE_REAL}/pending-update-result" \
    "${STATE_REAL}/failed-versions"
  rm -f "${STATE_REAL}"/state.json.tmp* "${STATE_REAL}"/last-heartbeat.tmp*
fi
nested_storage=no
if [ -n "$STORAGE_REAL" ] && [ "${RELAYIUM_NODE_PURGE_STORAGE:-}" != "1" ]; then
  case "$STORAGE_REAL" in
    "$STATE_REAL" | "$STATE_REAL"/*) nested_storage=yes ;;
  esac
fi
if [ "$nested_storage" = yes ]; then
  # Expected and understood, so it gets a plain explanation instead of the
  # "something unrecognised is in the way" report.
  if [ "$STORAGE_REAL" = "$STATE_REAL" ]; then
    say "kept ${STATE_DIR} — it IS the storage directory (removed only the node's own state files)"
  else
    say "kept ${STATE_DIR} — the storage directory lives inside it (removed only the node's own state files)"
  fi
elif finish_dir "$STATE_REAL" "state directory"; then
  # Gone. Remove the symlink too if the state dir was one: rm on a symlink
  # deletes only the link and would leave a dangling name behind.
  [ "$STATE_REAL" = "$STATE_DIR" ] || rm -f "$STATE_DIR"
else
  exit_code=2
fi

# ---------------------------------------------------------------------------
# Configuration. Same rule: the installer writes exactly one file here, so
# exactly one file is deleted and the directory is rmdir'd. It used to be
# `rm -rf "$CONF_DIR"` with no guard of any kind — no reject list, no test
# against the storage or state paths — so a node whose blobs lived at or under
# /etc/relayium-node had them deleted here, and the script then printed the
# "left N file(s) untouched" notice about files it had already destroyed.
#
# The Cloudflare record is named BEFORE the token and zone that manage it are
# deleted, so the reminder is still actionable.
# ---------------------------------------------------------------------------
if [ -n "$DOWNLOAD_URL" ]; then
  say "note: the DNS record for ${DOWNLOAD_URL} still points here — remove it in"
  if [ -n "$CF_ZONE" ]; then
    say "  Cloudflare (zone ${CF_ZONE}). The API token is about to be deleted with"
    say "  ${ENV_FILE}, so do it from the dashboard."
  else
    say "  Cloudflare. The API token is about to be deleted with ${ENV_FILE}."
  fi
fi
rm -f "$ENV_FILE"
finish_dir "$CONF_REAL" "configuration directory" || exit_code=2

# The service account the installer created. Best effort: a userdel that fails
# (processes still running, no shadow tools) must not fail the uninstall.
if command -v userdel >/dev/null 2>&1 && id relayium-node >/dev/null 2>&1; then
  userdel relayium-node >/dev/null 2>&1 || true
fi
if command -v groupdel >/dev/null 2>&1; then
  groupdel relayium-node >/dev/null 2>&1 || true
fi

if [ "$exit_code" = 0 ]; then
  say "relayium-node uninstalled."
else
  say "relayium-node uninstalled, but something was left behind — see above."
fi
exit "$exit_code"
