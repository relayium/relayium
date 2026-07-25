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
# Also remove the staged binary (set later, in the install dir — not under $tmp)
# so an interrupt between cp/chmod and the atomic mv doesn't leave a stray
# .relayium.new.<pid> behind in /usr/local/bin or ~/.local/bin.
trap 'rm -rf "$tmp"; [ -n "${staged:-}" ] && rm -f "$staged"' EXIT INT TERM

echo "Downloading ${asset}..."
dl "${BASE_URL}/${asset}" "${tmp}/${asset}" || err "download failed (has a release been published yet?)"
dl "${BASE_URL}/checksums.txt" "${tmp}/checksums.txt" || err "checksum list download failed"

# Release public key (ECDSA P-256, PKIX PEM). Empty until release signing is
# configured (setup notes live in the private relayium-ops repo); then we
# verify checksums.txt's signature with openssl — no cosign needed. Its private half is the
# RELAYIUM_RELEASE_KEY GitHub secret. This is the PUBLIC key, safe to publish.
RELEASE_PUBKEY='-----BEGIN PUBLIC KEY-----
MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAErOLLZclLFkpUWt8w4KIZ4SYB4JZf
bDRZOmWOdGsmHGKTU2GNeZZpJYPCL22ylULbxvQJEkdveZqkFIyYcGKNoA==
-----END PUBLIC KEY-----'

# Verify the checksum file's ECDSA signature so a tampered checksums.txt (e.g. a
# compromised release host) is rejected, not just a corrupted download. Skipped
# only when no key is embedded yet (checksum-only, unchanged behavior).
if [ -n "$RELEASE_PUBKEY" ]; then
  if command -v openssl >/dev/null 2>&1; then
    if dl "${BASE_URL}/checksums.txt.sig" "${tmp}/checksums.txt.sig"; then
      printf '%s\n' "$RELEASE_PUBKEY" > "${tmp}/relayium-release.pub"
      openssl dgst -sha256 -verify "${tmp}/relayium-release.pub" \
        -signature "${tmp}/checksums.txt.sig" "${tmp}/checksums.txt" >/dev/null 2>&1 \
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
# Stage in the target dir, then rename into place: cp over a running binary
# fails with ETXTBSY, while rename() atomically replaces it even mid-execution.
staged="${dir}/.relayium.new.$$"
cp "${tmp}/relayium" "$staged" || err "cannot write ${dir}/relayium"
chmod 0755 "$staged"
mv -f "$staged" "${dir}/relayium" || { rm -f "$staged"; err "cannot write ${dir}/relayium"; }

echo "Installed relayium to ${dir}/relayium"
case ":${PATH}:" in
  *":${dir}:"*) : ;;
  *) echo "Note: ${dir} is not on your PATH. Add: export PATH=\"${dir}:\$PATH\"" ;;
esac
echo "Run: relayium --help"
