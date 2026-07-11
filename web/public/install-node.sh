#!/bin/sh
# Relayium relay-node installer.
#   curl -fsSL https://relayium.com/install-node.sh | sh
# Required env: RELAYIUM_CENTRAL_URL, RELAYIUM_NODE_TOKEN.
# Optional: RELAYIUM_NODE_REGION, RELAYIUM_NODE_STORAGE_DIR (set to also store blobs, not just relay).
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

# Verify the checksum file's Sigstore (keyless) signature when cosign is present
# (signing identity = this repo's release workflow, via GitHub OIDC), rejecting a
# tampered checksums.txt. Without cosign, fall back to checksum-only integrity.
if command -v cosign >/dev/null 2>&1; then
  if curl -fsSL "${BASE_URL}/checksums.txt.sig" -o "$tmp/checksums.txt.sig" &&
     curl -fsSL "${BASE_URL}/checksums.txt.pem" -o "$tmp/checksums.txt.pem"; then
    cosign verify-blob \
      --certificate "$tmp/checksums.txt.pem" \
      --signature "$tmp/checksums.txt.sig" \
      --certificate-identity-regexp "^https://github.com/${REPO}/\.github/workflows/release\.yml@" \
      --certificate-oidc-issuer "https://token.actions.githubusercontent.com" \
      "$tmp/checksums.txt" >/dev/null 2>&1 || err "signature verification failed — refusing to install"
    echo "Verified release signature (cosign)."
  else
    echo "Note: signature files not found; falling back to checksum-only verification." >&2
  fi
else
  echo "Note: cosign not found; verifying checksum only. Install cosign for signature verification." >&2
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
EOF
  chmod 0600 /etc/relayium-node/env

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
CapabilityBoundingSet=
AmbientCapabilities=
${storage_rw}

[Install]
WantedBy=multi-user.target
EOF
  systemctl daemon-reload
  systemctl enable --now relayium-node
  echo "relayium-node.service enabled (locked-down, non-root) — check: systemctl status relayium-node"
  echo "it should appear online in ${RELAYIUM_CENTRAL_URL}/admin within ~30s"
else
  echo "not root or no systemd — run it yourself (unsandboxed; see ${RELAYIUM_CENTRAL_URL}/guides/bring-your-own-node for hardening):"
  echo "  RELAYIUM_CENTRAL_URL=${RELAYIUM_CENTRAL_URL} RELAYIUM_NODE_TOKEN=*** RELAYIUM_NODE_STORAGE_DIR=${RELAYIUM_NODE_STORAGE_DIR:-} ${INSTALL_DIR}/relayium-node"
fi
