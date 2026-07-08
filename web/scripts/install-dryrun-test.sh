#!/bin/sh
# Exercises install.sh against a local file:// fixture: builds a fake release
# asset + checksums, runs the installer, asserts the binary lands, and asserts a
# tampered checksum aborts. Requires curl (for file:// support).
set -eu

here=$(cd "$(dirname "$0")" && pwd)
installer="${here}/../public/install.sh"
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

os=$(uname -s); case "$os" in Linux) os=linux;; Darwin) os=darwin;; *) echo "SKIP: unsupported test OS"; exit 0;; esac
arch=$(uname -m); case "$arch" in x86_64|amd64) arch=amd64;; arm64|aarch64) arch=arm64;; *) echo "SKIP"; exit 0;; esac
asset="relayium_${os}_${arch}.tar.gz"

# Fake release dir
rel="${work}/rel"; mkdir -p "$rel"
printf '#!/bin/sh\necho fake-relayium\n' > "${work}/relayium"; chmod +x "${work}/relayium"
tar -czf "${rel}/${asset}" -C "$work" relayium
if command -v sha256sum >/dev/null 2>&1; then s=$(sha256sum "${rel}/${asset}" | awk '{print $1}');
else s=$(shasum -a 256 "${rel}/${asset}" | awk '{print $1}'); fi
printf '%s  %s\n' "$s" "$asset" > "${rel}/checksums.txt"

dest="${work}/bin"
# Happy path
RELAYIUM_BASE_URL="file://${rel}" RELAYIUM_INSTALL_DIR="$dest" sh "$installer" >/dev/null
[ -x "${dest}/relayium" ] || { echo "FAIL: binary not installed"; exit 1; }
[ "$("${dest}/relayium")" = "fake-relayium" ] || { echo "FAIL: wrong binary"; exit 1; }

# Tamper: corrupt the checksum, expect abort and no install
rm -f "${dest}/relayium"
printf '%s  %s\n' "deadbeef" "$asset" > "${rel}/checksums.txt"
if RELAYIUM_BASE_URL="file://${rel}" RELAYIUM_INSTALL_DIR="$dest" sh "$installer" >/dev/null 2>&1; then
  echo "FAIL: installer accepted a bad checksum"; exit 1
fi
[ ! -e "${dest}/relayium" ] || { echo "FAIL: binary installed despite bad checksum"; exit 1; }

echo "PASS: install.sh dry-run"
