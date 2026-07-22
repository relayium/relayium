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
# Optional:
#   RELAYIUM_NODE_PURGE_STORAGE=1  also delete the blob storage directory
#                                  (off by default: it holds other people's files)
#   RELAYIUM_NODE_FORCE=1          uninstall even though the node still holds files
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
envval() {
  [ -f "$ENV_FILE" ] || return 0
  sed -n "s/^$1=//p" "$ENV_FILE" | head -n1
}

STORAGE_DIR=$(envval RELAYIUM_NODE_STORAGE_DIR)
CENTRAL_URL=$(envval RELAYIUM_CENTRAL_URL)
NODE_TOKEN=$(envval RELAYIUM_NODE_TOKEN)
DOWNLOAD_URL=$(envval RELAYIUM_NODE_DOWNLOAD_URL)
STATE_DIR=$(envval RELAYIUM_NODE_STATE_DIR)
[ -n "$STATE_DIR" ] || STATE_DIR="${PREFIX}/var/lib/relayium-node"

# ---------------------------------------------------------------------------
# Refuse while the node still holds files. Nothing above this point deletes or
# changes anything, so a refusal leaves the machine exactly as it was.
# ---------------------------------------------------------------------------
stored_files=0
if [ -n "$STORAGE_DIR" ] && [ -d "$STORAGE_DIR" ]; then
  stored_files=$(find "$STORAGE_DIR" -type f 2>/dev/null | wc -l | tr -d ' ')
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
    echo "To destroy those files and uninstall anyway: RELAYIUM_NODE_FORCE=1"
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
rm -f "$BIN" "${BIN}.prev"

rm -rf "$CONF_DIR"

# ---------------------------------------------------------------------------
# The storage directory is OTHER PEOPLE'S FILES. Deleting it is opt-in, always.
# ---------------------------------------------------------------------------
if [ -n "$STORAGE_DIR" ] && [ -d "$STORAGE_DIR" ]; then
  if [ "${RELAYIUM_NODE_PURGE_STORAGE:-}" = "1" ]; then
    rm -rf "$STORAGE_DIR"
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
# and sits inside the state dir, remove the state files by name and leave the
# rest of the tree standing.
# ---------------------------------------------------------------------------
nested_storage=no
if [ -n "$STORAGE_DIR" ] && [ -d "$STORAGE_DIR" ]; then
  case "$STORAGE_DIR" in
    "$STATE_DIR"/*) nested_storage=yes ;;
  esac
fi
if [ "$nested_storage" = yes ]; then
  rm -f "${STATE_DIR}/state.json" "${STATE_DIR}/id.key" "${STATE_DIR}/id.crt" \
        "${STATE_DIR}/last-heartbeat" "${STATE_DIR}/pending-update-result" \
        "${STATE_DIR}/failed-versions"
  say "kept ${STATE_DIR} — the storage directory lives inside it (removed only the node's own state files)"
else
  rm -rf "$STATE_DIR"
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
