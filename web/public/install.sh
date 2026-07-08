#!/bin/sh
# Relayium CLI installer.
#   curl -fsSL https://relayium.com/install.sh | sh
# Env overrides: RELAYIUM_INSTALL_DIR (target dir), RELAYIUM_BASE_URL (download base).
set -eu

REPO="relayium/relayium"
BASE_URL="${RELAYIUM_BASE_URL:-https://github.com/${REPO}/releases/latest/download}"
INSTALL_DIR="${RELAYIUM_INSTALL_DIR:-}"

err() { echo "relayium-install: $*" >&2; exit 1; }

case "${1:-}" in
  -h|--help)
    echo "Installs the Relayium CLI from the latest GitHub release."
    echo "Env: RELAYIUM_INSTALL_DIR overrides the install directory."
    exit 0
    ;;
esac

os=$(uname -s)
case "$os" in
  Linux) os=linux ;;
  Darwin) os=darwin ;;
  *) err "unsupported OS '$os'. Windows: download the .zip from https://github.com/${REPO}/releases/latest" ;;
esac

arch=$(uname -m)
case "$arch" in
  x86_64|amd64) arch=amd64 ;;
  arm64|aarch64) arch=arm64 ;;
  *) err "unsupported architecture '$arch'" ;;
esac

asset="relayium_${os}_${arch}.tar.gz"

if command -v curl >/dev/null 2>&1; then
  dl() { curl -fsSL "$1" -o "$2"; }
elif command -v wget >/dev/null 2>&1; then
  dl() { wget -qO "$2" "$1"; }
else
  err "need curl or wget"
fi

if command -v sha256sum >/dev/null 2>&1; then
  sha() { sha256sum "$1" | awk '{print $1}'; }
elif command -v shasum >/dev/null 2>&1; then
  sha() { shasum -a 256 "$1" | awk '{print $1}'; }
else
  err "need sha256sum or shasum"
fi

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT INT TERM

echo "Downloading ${asset}..."
dl "${BASE_URL}/${asset}" "${tmp}/${asset}" || err "download failed (has a release been published yet?)"
dl "${BASE_URL}/checksums.txt" "${tmp}/checksums.txt" || err "checksum list download failed"

want=$(grep " ${asset}$" "${tmp}/checksums.txt" | awk '{print $1}')
[ -n "$want" ] || err "no checksum listed for ${asset}"
got=$(sha "${tmp}/${asset}")
[ "$want" = "$got" ] || err "checksum mismatch (expected ${want}, got ${got})"

tar -xzf "${tmp}/${asset}" -C "$tmp" relayium || err "extract failed"

if [ -n "$INSTALL_DIR" ]; then
  dir="$INSTALL_DIR"
elif [ -w /usr/local/bin ]; then
  dir=/usr/local/bin
else
  dir="${HOME}/.local/bin"
fi
mkdir -p "$dir" || err "cannot create ${dir}"
cp "${tmp}/relayium" "${dir}/relayium" || err "cannot write ${dir}/relayium"
chmod 0755 "${dir}/relayium"

echo "Installed relayium to ${dir}/relayium"
case ":${PATH}:" in
  *":${dir}:"*) : ;;
  *) echo "Note: ${dir} is not on your PATH. Add: export PATH=\"${dir}:\$PATH\"" ;;
esac
echo "Run: relayium --help"
