#!/bin/sh
# Relayium relay-node installer.
#   curl -fsSL https://relayium.com/install-node.sh | sh
# Required env: RELAYIUM_CENTRAL_URL, RELAYIUM_NODE_TOKEN. Optional: RELAYIUM_NODE_REGION.
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

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
# relayium-node ships in its own archive, separate from the relayium CLI's
# "relayium_<os>_<arch>.tar.gz" (see .goreleaser.yaml archives: id relayium-node).
asset="relayium-node_${os}_${arch}.tar.gz"
echo "downloading ${asset} ..."
curl -fsSL "${BASE_URL}/${asset}" -o "$tmp/a.tar.gz" || err "download failed"
tar -xzf "$tmp/a.tar.gz" -C "$tmp"
[ -f "$tmp/relayium-node" ] || err "relayium-node not found in archive"
install -m 0755 "$tmp/relayium-node" "${INSTALL_DIR}/relayium-node"
echo "installed ${INSTALL_DIR}/relayium-node"

# Set up a systemd service when running as root with systemd present.
if [ "$(id -u)" = "0" ] && command -v systemctl >/dev/null 2>&1; then
  mkdir -p /etc/relayium-node
  cat > /etc/relayium-node/env <<EOF
RELAYIUM_CENTRAL_URL=${RELAYIUM_CENTRAL_URL}
RELAYIUM_NODE_TOKEN=${RELAYIUM_NODE_TOKEN}
RELAYIUM_NODE_REGION=${RELAYIUM_NODE_REGION:-}
EOF
  chmod 0600 /etc/relayium-node/env
  cat > /etc/systemd/system/relayium-node.service <<EOF
[Unit]
Description=Relayium relay node
After=network-online.target
Wants=network-online.target

[Service]
EnvironmentFile=/etc/relayium-node/env
ExecStart=${INSTALL_DIR}/relayium-node
Restart=always
RestartSec=5
StateDirectory=relayium-node

[Install]
WantedBy=multi-user.target
EOF
  systemctl daemon-reload
  systemctl enable --now relayium-node
  echo "relayium-node.service enabled and started — check: systemctl status relayium-node"
  echo "it should appear online in ${RELAYIUM_CENTRAL_URL}/admin within ~30s"
else
  echo "not root or no systemd — run it yourself:"
  echo "  RELAYIUM_CENTRAL_URL=${RELAYIUM_CENTRAL_URL} RELAYIUM_NODE_TOKEN=*** ${INSTALL_DIR}/relayium-node"
fi
