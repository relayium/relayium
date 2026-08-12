#!/bin/sh
# Unit generation tests for web/public/install-node.sh.
#
# The installer is the only thing that decides what privileges a relay node has
# on its host, and this suite exists for one class of regression: the manual
# fast fleet rollout added a way for the UNPRIVILEGED node service to ask the
# ROOT updater to run. That channel is safe only because of properties that live
# entirely in generated systemd units — which unit is triggered, which path is
# watched, who owns the directory, and that the node's own service gained no
# write authority over its binary. None of that is observable from Go tests.
#
# Each case runs the installer against a scratch tree (RELAYIUM_NODE_PREFIX),
# with a stubbed download source, systemctl, useradd and id, then asserts on the
# unit files it wrote. POSIX sh, like the script under test.
#   sh scripts/test/install-node-test.sh
#
# Lives next to its subject and runs in CI — see .github/workflows/repo-hygiene.yml.
set -u

HERE=$(CDPATH='' cd -P -- "$(dirname -- "$0")" && pwd -P)
SCRIPT="$HERE/../../web/public/install-node.sh"
BASEPATH="$PATH"

TMPROOT=$(mktemp -d "${TMPDIR:-/tmp}/install-node-test.XXXXXX")
trap 'rm -rf "$TMPROOT"' EXIT
trap 'rm -rf "$TMPROOT"; exit 1' INT HUP TERM

fail=0
ok() { printf '  ok   %s\n' "$1"; }
bad() {
  printf '  FAIL %s\n' "$1"
  fail=1
}
check_rc() {
  if [ "$2" = "$3" ]; then ok "$1"; else
    bad "$1"
    printf '       want rc=%s got rc=%s\n' "$3" "$2"
    sed 's/^/       | /' "$TMPROOT/err" | tail -n 10
  fi
}
# assert_has FILE PATTERN NAME — PATTERN is a fixed string.
assert_has() {
  if grep -qF -- "$2" "$1" 2>/dev/null; then ok "$3"; else
    bad "$3 (missing from $1: $2)"
  fi
}
assert_lacks() {
  if grep -qF -- "$2" "$1" 2>/dev/null; then
    bad "$3 (present in $1: $2)"
  else ok "$3"; fi
}
assert_present() {
  if [ -e "$1" ] || [ -L "$1" ]; then ok "$2"; else bad "$2 (missing: $1)"; fi
}
assert_gone() {
  if [ -e "$1" ] || [ -L "$1" ]; then bad "$2 (still there: $1)"; else ok "$2"; fi
}

# ---------------------------------------------------------------------------
# Stubs. The installer wants root, systemd and a release to download; none of
# those may be real here.
# ---------------------------------------------------------------------------
STUB="$TMPROOT/stub"
mkdir -p "$STUB"
# id: claim to be root, and claim the service user does not exist yet.
cat >"$STUB/id" <<'EOF'
#!/bin/sh
case "${1:-}" in
  -u) echo 0 ;;
  *) exit 1 ;;
esac
EOF
cat >"$STUB/useradd" <<'EOF'
#!/bin/sh
exit 0
EOF
# systemctl: record every invocation so the test can assert which units were
# enabled, and never touch the host's systemd.
cat >"$STUB/systemctl" <<EOF
#!/bin/sh
echo "systemctl \$*" >> "$TMPROOT/systemctl.log"
exit 0
EOF
for c in id useradd systemctl; do chmod +x "$STUB/$c"; done

# A fake release: one tarball containing a "relayium-node" plus a checksums.txt,
# served through file:// so no network is touched. Signature verification is
# waived with RELAYIUM_ALLOW_UNSIGNED=1 (the installer's own documented escape
# hatch); signing itself is covered by the release-signing gates, not here.
RELEASE="$TMPROOT/release"
mkdir -p "$RELEASE/payload"
printf '#!/bin/sh\necho fake node\n' >"$RELEASE/payload/relayium-node"
chmod +x "$RELEASE/payload/relayium-node"
os=$(uname -s); case "$os" in Linux) os=linux ;; Darwin) os=darwin ;; esac
arch=$(uname -m); case "$arch" in x86_64|amd64) arch=amd64 ;; aarch64|arm64) arch=arm64 ;; esac
ASSET="relayium-node_${os}_${arch}.tar.gz"
(cd "$RELEASE/payload" && tar -czf "$RELEASE/$ASSET" relayium-node)
if command -v sha256sum >/dev/null 2>&1; then
  sum=$(sha256sum "$RELEASE/$ASSET" | awk '{print $1}')
else
  sum=$(shasum -a 256 "$RELEASE/$ASSET" | awk '{print $1}')
fi
printf '%s  %s\n' "$sum" "$ASSET" >"$RELEASE/checksums.txt"

RUNPATH="$STUB:$BASEPATH"

# run_installer PREFIX [EXTRA_ENV_ASSIGNMENTS...] — runs the installer against a
# fresh scratch tree and echoes its exit status into $rc.
run_installer() {
  p=$1
  shift
  rm -rf "$p"
  mkdir -p "$p/etc/systemd/system" "$p/usr/local/bin"
  : >"$TMPROOT/systemctl.log"
  env -i PATH="$RUNPATH" HOME="$TMPROOT" \
    RELAYIUM_NODE_PREFIX="$p" \
    RELAYIUM_BASE_URL="file://$RELEASE" \
    RELAYIUM_ALLOW_UNSIGNED=1 \
    RELAYIUM_INSTALL_DIR="$p/usr/local/bin" \
    RELAYIUM_CENTRAL_URL="https://central.test" \
    RELAYIUM_NODE_TOKEN="fleet-token" \
    "$@" \
    sh "$SCRIPT" >"$TMPROOT/out" 2>"$TMPROOT/err"
  rc=$?
}

echo "install-node.sh: default install (auto-update on)"
P="$TMPROOT/default"
run_installer "$P"
check_rc "installer succeeds" "$rc" 0

NODE_UNIT="$P/etc/systemd/system/relayium-node.service"
UPD_UNIT="$P/etc/systemd/system/relayium-node-update.service"
UPD_TIMER="$P/etc/systemd/system/relayium-node-update.timer"
REQ_PATH="$P/etc/systemd/system/relayium-node-update-request.path"

assert_present "$NODE_UNIT" "node service written"
assert_present "$UPD_UNIT" "root updater service written"
assert_present "$UPD_TIMER" "update timer written"
assert_present "$REQ_PATH" "update-request path unit written"

# THE RUNTIME DIRECTORY. It is the only place the unprivileged node may write
# outside its state dir, and systemd must create it — owned by the service user,
# owner-only — rather than the node conjuring it.
assert_has "$NODE_UNIT" "RuntimeDirectory=relayium-node" "node service declares its runtime directory"
assert_has "$NODE_UNIT" "RuntimeDirectoryMode=0700" "runtime directory is owner-only"
assert_has "$NODE_UNIT" "User=relayium-node" "node still runs as the unprivileged service user"

# NO SELF-WRITE AUTHORITY. The whole point of the separate root updater is that
# the node's own sandbox cannot replace its binary. ReadWritePaths is the only
# thing that opens a path under ProtectSystem=strict, so the install dir must
# never appear there — and the node service must not be given the updater's
# powers by another route either.
assert_has "$NODE_UNIT" "ProtectSystem=strict" "node sandbox still read-only on the system"
assert_has "$NODE_UNIT" "NoNewPrivileges=yes" "node cannot gain privileges"
assert_lacks "$NODE_UNIT" "ReadWritePaths=$P/usr/local/bin" "node service cannot write its own binary"
assert_lacks "$NODE_UNIT" "relayium-node update" "node service does not run the updater itself"
assert_lacks "$NODE_UNIT" "ExecStartPost" "node service has no post-start escape hatch"

# THE PATH UNIT'S ALLOWLIST: exactly one path watched, exactly one unit started,
# and that unit is the dedicated root updater that already existed. A broad
# target here (say relayium-node.service, or a template unit) would turn a
# node-writable file into control over an arbitrary service.
assert_has "$REQ_PATH" "PathExists=/run/relayium-node/update-requested" "path unit watches exactly the request marker"
assert_has "$REQ_PATH" "Unit=relayium-node-update.service" "path unit triggers exactly the root updater"
assert_lacks "$REQ_PATH" "PathChanged" "path unit does not re-trigger on content changes"
assert_lacks "$REQ_PATH" "PathModified" "path unit does not re-trigger on writes"
# One and only one Unit= / PathExists= line, so a second target cannot ride along.
n=$(grep -c '^Unit=' "$REQ_PATH")
if [ "$n" = 1 ]; then ok "path unit names a single unit"; else bad "path unit has $n Unit= lines"; fi
n=$(grep -c '^Path' "$REQ_PATH")
if [ "$n" = 1 ]; then ok "path unit watches a single path"; else bad "path unit has $n Path* lines"; fi

# The updater keeps being the sole installer, and it is still the thing that
# asks central: the request carries no version, so the unit must not have gained
# arguments from anywhere.
assert_has "$UPD_UNIT" "ExecStart=$P/usr/local/bin/relayium-node update" "root updater runs the plain update command"
assert_lacks "$UPD_UNIT" "-to " "root updater is never handed a version"
assert_lacks "$UPD_UNIT" "User=" "root updater is the only unit that runs as root"

# The env file tells the updater where to look for the marker, since it is a
# separate unit and does not inherit RUNTIME_DIRECTORY.
assert_has "$P/etc/relayium-node/env" "RELAYIUM_NODE_RUNTIME_DIR=/run/relayium-node" \
  "env file records the runtime directory for the updater"

# Enablement: the path unit has to actually be enabled, or the acceleration is
# inert and every rollout silently falls back to the timer.
assert_has "$TMPROOT/systemctl.log" "enable --now relayium-node-update-request.path" \
  "path unit is enabled"
assert_has "$TMPROOT/systemctl.log" "enable --now relayium-node-update-request.path" \
  "path unit is started as well as enabled"

echo
echo "install-node.sh: auto-update off"
P="$TMPROOT/noupdate"
run_installer "$P" RELAYIUM_NODE_AUTO_UPDATE=off
check_rc "installer succeeds with auto-update off" "$rc" 0
assert_present "$P/etc/systemd/system/relayium-node.service" "node service still written"
assert_gone "$P/etc/systemd/system/relayium-node-update.service" "no updater service"
assert_gone "$P/etc/systemd/system/relayium-node-update.timer" "no update timer"
# The request path unit must go with them. Leaving it behind would keep a
# root-triggering watcher on a host whose operator turned auto-update OFF —
# pointing at a unit that no longer exists, and contradicting the summary.
assert_gone "$P/etc/systemd/system/relayium-node-update-request.path" \
  "no update-request path unit when auto-update is off"

echo
echo "install-node.sh: auto-update off removes units from a previous install"
P="$TMPROOT/downgrade"
run_installer "$P"
check_rc "first install (auto-update on) succeeds" "$rc" 0
assert_present "$P/etc/systemd/system/relayium-node-update-request.path" "path unit installed first"
# Re-run with auto-update off against the SAME tree, which is how an operator
# turns it off.
: >"$TMPROOT/systemctl.log"
env -i PATH="$RUNPATH" HOME="$TMPROOT" \
  RELAYIUM_NODE_PREFIX="$P" \
  RELAYIUM_BASE_URL="file://$RELEASE" \
  RELAYIUM_ALLOW_UNSIGNED=1 \
  RELAYIUM_INSTALL_DIR="$P/usr/local/bin" \
  RELAYIUM_CENTRAL_URL="https://central.test" \
  RELAYIUM_NODE_TOKEN="fleet-token" \
  RELAYIUM_NODE_AUTO_UPDATE=off \
  sh "$SCRIPT" >"$TMPROOT/out" 2>"$TMPROOT/err"
rc=$?
check_rc "re-run with auto-update off succeeds" "$rc" 0
assert_gone "$P/etc/systemd/system/relayium-node-update-request.path" \
  "turning auto-update off removes the path unit"
assert_gone "$P/etc/systemd/system/relayium-node-update.timer" \
  "turning auto-update off removes the timer"
assert_has "$TMPROOT/systemctl.log" "disable --now relayium-node-update-request.path" \
  "path unit is disabled, not just deleted"

echo
if [ "$fail" = 0 ]; then
  echo "install-node.sh: all cases passed"
else
  echo "install-node.sh: FAILURES above"
fi
exit "$fail"
