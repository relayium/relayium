#!/bin/sh
# Relayium relay-node installer (v0.9 — movable ports; direct-download defaults to :2053).
#   curl -fsSL https://relayium.com/install-node.sh | sh
# Required env: RELAYIUM_CENTRAL_URL, RELAYIUM_NODE_TOKEN.
# Optional:
#   RELAYIUM_NODE_REGION
#   RELAYIUM_NODE_STORAGE_DIR   set to also store blobs (not just relay)
# Direct download (fleet nodes serve stored downloads themselves, bypassing
# central; needs RELAYIUM_NODE_STORAGE_DIR too):
#   RELAYIUM_NODE_DOWNLOAD_URL  public https base, e.g. https://node7.relayium.com
#   RELAYIUM_NODE_DOWNLOAD_ADDR public listener (default :2053). Cloudflare's orange cloud
#                               only proxies to 443/2053/2083/2087/2096/8443 — pick one of those.
#   RELAYIUM_NODE_CF_TOKEN      Cloudflare API token (Zone:DNS:Edit) to auto-create the A record
#   RELAYIUM_NODE_CF_ZONE       Cloudflare zone id for the download domain
# Port conflicts (a node often shares a host with other services):
#   RELAYIUM_NODE_TURN_PORT     TURN UDP port (default 3478)
#   RELAYIUM_NODE_STORAGE_PORT  blob HTTP port, central-facing only (default 8081)
#   RELAYIUM_NODE_MIN_PORT / RELAYIUM_NODE_MAX_PORT  relay UDP range (default 49152-65535)
# Self-update (central-driven, root+systemd only):
#   RELAYIUM_NODE_AUTO_UPDATE   on|off (default on). A timer polls central every
#                               ~10min asking what version to run; central only ever
#                               hands out a version NUMBER, the binary itself is
#                               downloaded and signature-verified locally, same as
#                               this installer does. Set to off (and re-run this
#                               installer) to disable and remove the timer.
set -eu

REPO="relayium/relayium"
BASE_URL="${RELAYIUM_BASE_URL:-https://github.com/${REPO}/releases/latest/download}"
INSTALL_DIR="${RELAYIUM_INSTALL_DIR:-/usr/local/bin}"

err() { echo "relayium-node-install: $*" >&2; exit 1; }

[ -n "${RELAYIUM_CENTRAL_URL:-}" ] || err "set RELAYIUM_CENTRAL_URL (e.g. https://relayium.com)"
[ -n "${RELAYIUM_NODE_TOKEN:-}" ]  || err "set RELAYIUM_NODE_TOKEN (fleet bootstrap token)"

os=$(uname -s)
case "$os" in
  Linux) os=linux ;;
  Darwin) os=darwin ;;
  *) err "unsupported OS '$os'" ;;
esac
arch=$(uname -m)
case "$arch" in
  x86_64|amd64) arch=amd64 ;;
  aarch64|arm64) arch=arm64 ;;
  *) err "unsupported arch '$arch'" ;;
esac

if command -v sha256sum >/dev/null 2>&1; then
  sha() { sha256sum "$1" | awk '{print $1}'; }
elif command -v shasum >/dev/null 2>&1; then
  sha() { shasum -a 256 "$1" | awk '{print $1}'; }
else
  err "need sha256sum or shasum"
fi

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
# relayium-node ships in its own archive, separate from the relayium CLI's
# "relayium_<os>_<arch>.tar.gz" (see .goreleaser.yaml archives: id relayium-node).
asset="relayium-node_${os}_${arch}.tar.gz"
echo "downloading ${asset} ..."
curl -fsSL "${BASE_URL}/${asset}" -o "$tmp/a.tar.gz" || err "download failed"
curl -fsSL "${BASE_URL}/checksums.txt" -o "$tmp/checksums.txt" || err "checksum list download failed"

# Release public key (ECDSA P-256, PKIX PEM). Empty until release signing is
# configured (see docs/release-signing.md); then verify checksums.txt's signature
# with openssl — no cosign needed. Private half = RELAYIUM_RELEASE_KEY secret.
RELEASE_PUBKEY='-----BEGIN PUBLIC KEY-----
MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAErOLLZclLFkpUWt8w4KIZ4SYB4JZf
bDRZOmWOdGsmHGKTU2GNeZZpJYPCL22ylULbxvQJEkdveZqkFIyYcGKNoA==
-----END PUBLIC KEY-----'

# Verify the checksum file's ECDSA signature so a tampered checksums.txt (e.g. a
# compromised release host) is rejected, not just a corrupted download.
if [ -n "$RELEASE_PUBKEY" ]; then
  if command -v openssl >/dev/null 2>&1; then
    if curl -fsSL "${BASE_URL}/checksums.txt.sig" -o "$tmp/checksums.txt.sig"; then
      printf '%s\n' "$RELEASE_PUBKEY" > "$tmp/relayium-release.pub"
      openssl dgst -sha256 -verify "$tmp/relayium-release.pub" \
        -signature "$tmp/checksums.txt.sig" "$tmp/checksums.txt" >/dev/null 2>&1 \
        || err "signature verification failed — refusing to install"
      echo "Verified release signature."
    elif [ "${RELAYIUM_ALLOW_UNSIGNED:-}" = "1" ]; then
      echo "WARNING: release signature not found; verifying checksum only (RELAYIUM_ALLOW_UNSIGNED=1)." >&2
    else
      err "release signature not found — refusing to install (set RELAYIUM_ALLOW_UNSIGNED=1 to override)"
    fi
  else
    echo "Note: openssl not found; verifying checksum only." >&2
  fi
fi

want=$(grep " ${asset}$" "$tmp/checksums.txt" | awk '{print $1}')
[ -n "$want" ] || err "no checksum listed for ${asset}"
got=$(sha "$tmp/a.tar.gz")
[ "$want" = "$got" ] || err "checksum mismatch (expected ${want}, got ${got})"

tar -xzf "$tmp/a.tar.gz" -C "$tmp"
[ -f "$tmp/relayium-node" ] || err "relayium-node not found in archive"
install -m 0755 "$tmp/relayium-node" "${INSTALL_DIR}/relayium-node"
echo "installed ${INSTALL_DIR}/relayium-node"

# Set up a systemd service when running as root with systemd present.
if [ "$(id -u)" = "0" ] && command -v systemctl >/dev/null 2>&1; then
  # Dedicated unprivileged user (no login, no home) so a compromised node can't
  # reach the rest of the host — SSH keys, other services, your files. Idempotent.
  if ! id relayium-node >/dev/null 2>&1; then
    useradd --system --no-create-home --shell /usr/sbin/nologin relayium-node 2>/dev/null \
      || useradd --system --no-create-home relayium-node 2>/dev/null || true
  fi

  mkdir -p /etc/relayium-node
  cat > /etc/relayium-node/env <<EOF
RELAYIUM_CENTRAL_URL=${RELAYIUM_CENTRAL_URL}
RELAYIUM_NODE_TOKEN=${RELAYIUM_NODE_TOKEN}
RELAYIUM_NODE_REGION=${RELAYIUM_NODE_REGION:-}
RELAYIUM_NODE_STORAGE_DIR=${RELAYIUM_NODE_STORAGE_DIR:-}
RELAYIUM_NODE_DOWNLOAD_URL=${RELAYIUM_NODE_DOWNLOAD_URL:-}
RELAYIUM_NODE_DOWNLOAD_ADDR=${RELAYIUM_NODE_DOWNLOAD_ADDR:-:2053}
RELAYIUM_NODE_CF_TOKEN=${RELAYIUM_NODE_CF_TOKEN:-}
RELAYIUM_NODE_CF_ZONE=${RELAYIUM_NODE_CF_ZONE:-}
RELAYIUM_NODE_TURN_PORT=${RELAYIUM_NODE_TURN_PORT:-}
RELAYIUM_NODE_STORAGE_PORT=${RELAYIUM_NODE_STORAGE_PORT:-}
RELAYIUM_NODE_MIN_PORT=${RELAYIUM_NODE_MIN_PORT:-}
RELAYIUM_NODE_MAX_PORT=${RELAYIUM_NODE_MAX_PORT:-}
RELAYIUM_NODE_BIN=${INSTALL_DIR}/relayium-node
RELAYIUM_NODE_AUTO_UPDATE=${RELAYIUM_NODE_AUTO_UPDATE:-on}
EOF
  chmod 0600 /etc/relayium-node/env

  # A public download listener on a privileged port (<1024, e.g. :443) needs
  # CAP_NET_BIND_SERVICE — the only capability we ever grant this otherwise
  # capability-less sandbox, and only when direct download is actually configured
  # on a low port. The default :2053 stays above 1024, so the common case grants
  # nothing at all.
  bind_caps=""
  dl_addr="${RELAYIUM_NODE_DOWNLOAD_ADDR:-:2053}"
  dl_port="${dl_addr##*:}"
  if [ -n "${RELAYIUM_NODE_DOWNLOAD_URL:-}" ] && [ -n "$dl_port" ] && [ "$dl_port" -lt 1024 ] 2>/dev/null; then
    bind_caps="CapabilityBoundingSet=CAP_NET_BIND_SERVICE
AmbientCapabilities=CAP_NET_BIND_SERVICE"
  fi

  # Two ways the download listener silently fails to serve anyone; both are far
  # cheaper to catch here than from a 522 an hour later.
  if [ -n "${RELAYIUM_NODE_DOWNLOAD_URL:-}" ]; then
    case "$dl_port" in
      443|2053|2083|2087|2096|8443) ;;
      *) err "download port '${dl_port}' is not one Cloudflare's proxy forwards to — use 443, 2053, 2083, 2087, 2096 or 8443" ;;
    esac
  fi
  # Warn (don't fail) on ports already taken: the node would otherwise just
  # crash-loop on bind, which reads as "the install broke". Only sees what is
  # listening right now, so a stopped-but-installed service still slips through.
  port_busy() { # $1=t|u (tcp/udp), $2=port
    command -v ss >/dev/null 2>&1 || return 1
    ss -ln"$1" 2>/dev/null | grep -qE "[:.]$2[[:space:]]"
  }
  warn_busy() { # $1=t|u, $2=port, $3=label, $4=env var to change
    if port_busy "$1" "$2"; then
      echo "WARNING: $3 port $2 is already in use — the node may fail to bind." >&2
      echo "         Re-run with $4 set to a free port." >&2
    fi
  }
  if [ -n "${RELAYIUM_NODE_DOWNLOAD_URL:-}" ]; then
    warn_busy t "$dl_port" "download" "RELAYIUM_NODE_DOWNLOAD_ADDR=:2083"
  fi
  warn_busy t "${RELAYIUM_NODE_STORAGE_PORT:-8081}" "storage" "RELAYIUM_NODE_STORAGE_PORT"
  warn_busy u "${RELAYIUM_NODE_TURN_PORT:-3478}" "TURN" "RELAYIUM_NODE_TURN_PORT"

  # Hand the state dir to the node user (also migrates a prior root install).
  [ -d /var/lib/relayium-node ] && chown -R relayium-node:relayium-node /var/lib/relayium-node 2>/dev/null || true

  # If this node stores blobs, create + lock down the storage dir and grant the
  # sandbox write+noexec on exactly that path (nothing else on disk is writable).
  storage_rw=""
  if [ -n "${RELAYIUM_NODE_STORAGE_DIR:-}" ]; then
    mkdir -p "${RELAYIUM_NODE_STORAGE_DIR}"
    chown -R relayium-node:relayium-node "${RELAYIUM_NODE_STORAGE_DIR}" 2>/dev/null || true
    chmod 700 "${RELAYIUM_NODE_STORAGE_DIR}"
    storage_rw="ReadWritePaths=${RELAYIUM_NODE_STORAGE_DIR}
NoExecPaths=${RELAYIUM_NODE_STORAGE_DIR}"
  fi

  cat > /etc/systemd/system/relayium-node.service <<EOF
[Unit]
Description=Relayium relay node
After=network-online.target
Wants=network-online.target

[Service]
# Runs as a locked-down non-root user. See ${RELAYIUM_CENTRAL_URL}/guides/bring-your-own-node
# for what each hardening line defends against.
User=relayium-node
Group=relayium-node
EnvironmentFile=/etc/relayium-node/env
ExecStart=${INSTALL_DIR}/relayium-node
Restart=always
RestartSec=5
TimeoutStopSec=90
StateDirectory=relayium-node
StateDirectoryMode=0700

# Hardening — cap the blast radius if the node is ever compromised.
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectControlGroups=yes
RestrictSUIDSGID=yes
LockPersonality=yes
${bind_caps:-CapabilityBoundingSet=
AmbientCapabilities=}
${storage_rw}

[Install]
WantedBy=multi-user.target
EOF
  systemctl daemon-reload
  systemctl enable --now relayium-node
  echo "relayium-node.service enabled (locked-down, non-root) — check: systemctl status relayium-node"
  echo "it should appear online in ${RELAYIUM_CENTRAL_URL}/admin within ~30s"
  echo "auto-update: central only ever hands out a version NUMBER; the binary is downloaded"
  echo "and signature-verified on this machine, same as this installer just did — never trust-on-say-so."
  echo "to disable auto-update: re-run this installer with RELAYIUM_NODE_AUTO_UPDATE=off"

  # Self-update: a timer that asks central what version to run, plus the
  # oneshot service it triggers. Deliberately a SEPARATE, unsandboxed unit from
  # relayium-node.service above — replacing the live binary needs root and a
  # writable /usr/local/bin (or wherever INSTALL_DIR points), which is exactly
  # what the node's own sandbox (ProtectSystem=strict, empty capability set,
  # ...) exists to deny it. Keeping that power in one small, single-purpose
  # unit — rather than loosening the node's own hardening — is the point.
  auto_update="${RELAYIUM_NODE_AUTO_UPDATE:-on}"
  update_service=/etc/systemd/system/relayium-node-update.service
  update_timer=/etc/systemd/system/relayium-node-update.timer
  if [ "$auto_update" = "on" ]; then
    cat > "$update_service" <<EOF
[Unit]
Description=Relayium node self-update (central-driven)
After=network-online.target

[Service]
Type=oneshot
EnvironmentFile=/etc/relayium-node/env
ExecStart=${INSTALL_DIR}/relayium-node update
# The watchdog waits up to 10 minutes for the new version to prove itself.
# systemd's default TimeoutStartSec (90s) would SIGTERM the updater mid-watch,
# leaving an unverified binary, a stale .prev and no rollback. Must exceed
# healthWindow with room for the 60s drain plus the download.
TimeoutStartSec=20min
EOF

    cat > "$update_timer" <<EOF
[Unit]
Description=Check for a Relayium node update

[Timer]
OnBootSec=5min
OnUnitActiveSec=10min
# Smear polls across the fleet so central isn't hit in lockstep. Central
# enforces one-node-at-a-time regardless; this only spreads the questions.
RandomizedDelaySec=5min
Persistent=true

[Install]
WantedBy=timers.target
EOF
    systemctl daemon-reload
    systemctl enable --now relayium-node-update.timer
    echo "relayium-node-update.timer enabled — polls central for a new version every ~10min (auto-update: on)"
  else
    if [ -f "$update_timer" ] || [ -f "$update_service" ]; then
      systemctl disable --now relayium-node-update.timer 2>/dev/null || true
      rm -f "$update_timer" "$update_service"
      systemctl daemon-reload
      echo "relayium-node-update.timer disabled and removed (RELAYIUM_NODE_AUTO_UPDATE=off)"
    else
      echo "auto-update: off (RELAYIUM_NODE_AUTO_UPDATE=off) — not installing the update timer"
    fi
  fi

  # ── Closing summary: a truthful, specific account of what root was just
  # used for. Every clause below is conditioned on what was ACTUALLY done
  # above (auto-update on/off, storage configured or not, the capability
  # actually granted) rather than describing a fixed installation — a
  # relay-only node and a storage node were just set up differently, so the
  # summary must say different things about them.
  if [ "$auto_update" = "on" ]; then
    update_units=", relayium-node-update.service, relayium-node-update.timer"
    update_state="enabled — central hands out only a version NUMBER; the binary itself is downloaded and signature-verified on this machine by a key compiled into the updater, the same check this installer just did (RELAYIUM_NODE_AUTO_UPDATE=off to disable)"
  else
    update_units=""
    update_state="disabled (RELAYIUM_NODE_AUTO_UPDATE=off) — re-run this installer with RELAYIUM_NODE_AUTO_UPDATE=on to enable"
  fi

  if [ -n "$bind_caps" ]; then
    cap_note="one capability: CAP_NET_BIND_SERVICE, so the download listener can bind port ${dl_port} (<1024)"
  else
    cap_note="no Linux capabilities"
  fi

  # The relay UDP range binds on every node, storage or not, so it appears in
  # both branches below — only the storage/blob-port clause is conditional.
  relay_ports_note="relay ${RELAYIUM_NODE_MIN_PORT:-49152}-${RELAYIUM_NODE_MAX_PORT:-65535}/udp"
  if [ -n "${RELAYIUM_NODE_STORAGE_DIR:-}" ]; then
    write_note="the state dir and ${RELAYIUM_NODE_STORAGE_DIR} (also noexec) — nothing else on disk"
    ports_note="TURN ${RELAYIUM_NODE_TURN_PORT:-3478}/udp, ${relay_ports_note}, storage ${RELAYIUM_NODE_STORAGE_PORT:-8081}/tcp (central-facing only)"
  else
    write_note="the state dir only — nothing else on disk (no storage configured on this node)"
    ports_note="TURN ${RELAYIUM_NODE_TURN_PORT:-3478}/udp, ${relay_ports_note} (relay only — no storage dir, so the blob port never opens)"
  fi
  if [ -n "${RELAYIUM_NODE_DOWNLOAD_URL:-}" ]; then
    ports_note="${ports_note}, download ${dl_port}/tcp (${RELAYIUM_NODE_DOWNLOAD_URL})"
  fi

  cat <<SUMMARY

  ── what this installer just did with your root ──────────────
   user      created system user 'relayium-node' (no login shell, no home);
             the node runs as this user, never as root
   sandbox   ProtectSystem=strict, ProtectHome=yes, NoNewPrivileges=yes,
             ${cap_note}; writable: ${write_note}
   units     relayium-node.service${update_units}
   ports     ${ports_note}
   updates   ${update_state}
   data      files stored here are encrypted by the sender before upload;
             this node holds no keys and cannot read what it stores
   remove    curl -fsSL ${RELAYIUM_CENTRAL_URL}/uninstall-node.sh -o uninstall-node.sh &&
             [ -s uninstall-node.sh ] && sudo sh uninstall-node.sh
             (never pipe straight into sh here: a 404 makes "curl | sh" print
             nothing and exit 0, which reads as a successful uninstall)

  Full details: ${RELAYIUM_CENTRAL_URL}/guides/bring-your-own-node
  ─────────────────────────────────────────────────────────────

SUMMARY
else
  echo "not root or no systemd — run it yourself (unsandboxed; see ${RELAYIUM_CENTRAL_URL}/guides/bring-your-own-node for hardening):"
  echo "  RELAYIUM_CENTRAL_URL=${RELAYIUM_CENTRAL_URL} RELAYIUM_NODE_TOKEN=*** RELAYIUM_NODE_STORAGE_DIR=${RELAYIUM_NODE_STORAGE_DIR:-} ${INSTALL_DIR}/relayium-node"
fi
