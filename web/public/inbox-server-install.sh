#!/bin/sh
# Relayium Device Inbox installer for a Linux server with systemd.
#
# Recommended use (download, inspect, then run):
#   curl -fsSLO https://relayium.com/inbox-server-install.sh
#   less inbox-server-install.sh
#   sudo sh inbox-server-install.sh --dir /srv/relayium-inbox
#
# Run `relayium login --device-name <label>` before this script. The installer
# copies that device credential into a dedicated, unprivileged service account;
# it never prints the credential. The receiving worker then owns only its state
# and the selected receive directory.
set -eu

service_user=relayium
receive_dir=/srv/relayium-inbox
source_config=${RELAYIUM_CONFIG_DIR:-}

fail() { echo "relayium-inbox-install: $*" >&2; exit 1; }
say() { echo "relayium-inbox-install: $*"; }

usage() {
  cat <<'EOF'
Usage: sudo sh inbox-server-install.sh [--dir /srv/relayium-inbox] [--config-dir DIR]

Installs Relayium Device Inbox as an always-on systemd service under the
dedicated, unprivileged `relayium` account. Run `relayium login` first.

Options:
  --dir DIR         receive directory (default /srv/relayium-inbox)
  --config-dir DIR  existing logged-in CLI config (default: invoking user's)
  -h, --help        show this help
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --dir) [ "$#" -ge 2 ] || fail "--dir needs a value"; receive_dir=$2; shift 2 ;;
    --config-dir) [ "$#" -ge 2 ] || fail "--config-dir needs a value"; source_config=$2; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) fail "unknown option: $1" ;;
  esac
done

[ "$(uname -s)" = Linux ] || fail "this installer is for Linux; see relayium inbox service launchd on macOS"
[ "$(id -u)" -eq 0 ] || fail "run this system-wide installer with sudo (or as root)"
command -v systemctl >/dev/null 2>&1 || fail "systemd/systemctl is required"
command -v runuser >/dev/null 2>&1 || fail "runuser is required (normally provided by util-linux)"

relayium_bin=$(command -v relayium || true)
[ -n "$relayium_bin" ] || fail "relayium is not on PATH; install/update it first from https://relayium.com/cli"
relayium_bin=$(readlink -f "$relayium_bin" 2>/dev/null || printf '%s' "$relayium_bin")

if [ -z "$source_config" ]; then
  invoking_user=${SUDO_USER:-root}
  [ "$invoking_user" != root ] || invoking_user=root
  invoking_home=$(getent passwd "$invoking_user" | cut -d: -f6)
  [ -n "$invoking_home" ] || fail "cannot find the invoking user's home; pass --config-dir"
  source_config=$invoking_home/.config/relayium
fi

[ -f "$source_config/credentials" ] || fail "no login found at $source_config; run relayium login first or pass --config-dir"
case "$receive_dir" in
  /*) : ;;
  *) fail "--dir must be an absolute path (recommended: /srv/relayium-inbox)" ;;
esac
case "$receive_dir/" in
  /root/*|/home/*|/run/user/*) fail "--dir cannot be inside a home directory; the hardened service cannot access it (use /srv/relayium-inbox)" ;;
esac

service_config=/var/lib/relayium-inbox/config
unit=/etc/systemd/system/relayium-inbox.service
tmp_dir=$(mktemp -d)
trap 'rm -rf "$tmp_dir"' EXIT INT TERM

if ! getent passwd "$service_user" >/dev/null 2>&1; then
  say "creating unprivileged service account: $service_user"
  useradd --system --home-dir /var/lib/relayium-inbox --create-home --shell /usr/sbin/nologin "$service_user"
fi

say "creating the receive directory: $receive_dir"
install -d -o "$service_user" -g "$service_user" -m 0750 "$receive_dir"
install -d -o "$service_user" -g "$service_user" -m 0700 "$service_config"
install -o "$service_user" -g "$service_user" -m 0600 "$source_config/credentials" "$service_config/credentials"

say "enrolling the existing CLI device and creating its private receive key"
runuser -u "$service_user" -- "$relayium_bin" inbox enable \
  --dir "$receive_dir" --config-dir "$service_config"

say "rendering and installing the hardened systemd unit"
"$relayium_bin" inbox service systemd-system \
  --config-dir "$service_config" --dir "$receive_dir" --service-user "$service_user" \
  > "$tmp_dir/relayium-inbox.service" 2> "$tmp_dir/render-notes"
install -o root -g root -m 0644 "$tmp_dir/relayium-inbox.service" "$unit"

systemctl daemon-reload
if ! systemctl enable --now relayium-inbox.service; then
  say "service start failed; recent logs follow"
  journalctl -u relayium-inbox.service -n 50 --no-pager >&2 || true
  fail "systemd could not start relayium-inbox.service"
fi

# An earlier foreground setup may hold an obsolete private key for the same
# device. Move it aside only after the service is proven running; this is
# recoverable and prevents two independently locked workers from rotating the
# device key back and forth.
if [ "$source_config" != "$service_config" ] && [ -d "$source_config/inbox" ]; then
  archived="$source_config/inbox.disabled-after-system-service.$(date +%Y%m%d%H%M%S)"
  mv "$source_config/inbox" "$archived"
  say "archived the old foreground inbox state at $archived"
fi

say "Device Inbox is running now and will start after reboot."
systemctl --no-pager --full status relayium-inbox.service || true
echo
echo "Receive directory: $receive_dir"
echo "Check later:       sudo systemctl status relayium-inbox.service"
echo "Follow logs:       sudo journalctl -u relayium-inbox.service -f"
echo "Inbox truth:       sudo -u $service_user $relayium_bin inbox status --config-dir $service_config"
