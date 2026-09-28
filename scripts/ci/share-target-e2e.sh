#!/usr/bin/env bash
# scripts/ci/share-target-e2e.sh — run web/e2e/share-target.mjs against a real
# Go server serving the freshly built web/dist, and tear the server down.
#
# `share-target.mjs` exercises the INSTALLED production service worker: a
# multipart POST to /share-target is intercepted by the worker, parked in Cache
# Storage and drained into the live outbox. `vite preview` would serve the
# bundle, but the scenario's precondition is `requireServer`'s `/healthz`, which
# only the real server answers — and the real server is what users hit. Unlike
# `mixed-link.mjs`, the scenario does not start its own server, so this wrapper
# does, with the same isolation `web/e2e/go-server.mjs` `serverEnv` applies: a
# throwaway database and blob directory, no inherited RELAYIUM_* variables, no
# env file, and no outbound release check.
#
# Usage: scripts/ci/share-target-e2e.sh     (from the repository root, after
#                                            `npm ci && npm run build` in web/)
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/../.." && pwd -P)"
port="${RELAYIUM_SHARE_TARGET_PORT:-8099}"
base="http://127.0.0.1:$port"
dist="$repo_root/web/dist"

[ -f "$dist/index.html" ] || { echo "error: $dist/index.html is missing; run npm run build in web/ first" >&2; exit 2; }

work="$(mktemp -d "${TMPDIR:-/tmp}/relayium-share-target.XXXXXX")"
server_pid=""
cleanup() {
  status=$?
  if [ -n "$server_pid" ] && kill -0 "$server_pid" 2>/dev/null; then
    kill "$server_pid" 2>/dev/null || true
    wait "$server_pid" 2>/dev/null || true
  fi
  if [ "$status" -ne 0 ] && [ -s "$work/server.log" ]; then
    echo "---- server.log (last 40 lines)" >&2
    tail -40 "$work/server.log" >&2 || true
  fi
  rm -rf "$work"
  exit "$status"
}
trap cleanup EXIT INT TERM

( cd "$repo_root/server" && go build -o "$work/relayium-server" . )

# Only the variables serverEnv sets; nothing RELAYIUM_* leaks in from the runner.
for name in $(env | sed -n 's/^\(RELAYIUM_[A-Za-z0-9_]*\)=.*/\1/p'); do unset "$name"; done
RELAYIUM_ADDR="127.0.0.1:$port" \
RELAYIUM_BASE_URL="$base" \
RELAYIUM_DB="$work/relayium.db" \
RELAYIUM_BLOB_DIR="$work/blobs" \
RELAYIUM_STATIC="$dist" \
RELAYIUM_ENV_FILE="$work/no-such.env" \
RELAYIUM_RELEASE_CHECK=0 \
  "$work/relayium-server" >"$work/server.log" 2>&1 &
server_pid=$!

deadline=$(( $(date +%s) + 60 ))
until [ "$(curl -fsS "$base/healthz" 2>/dev/null || true)" = "ok" ]; do
  kill -0 "$server_pid" 2>/dev/null || { echo "error: the server exited before it was healthy" >&2; exit 1; }
  [ "$(date +%s)" -lt "$deadline" ] || { echo "error: the server was not healthy at $base within 60 s" >&2; exit 1; }
  sleep 0.2
done
echo "server healthy at $base"

cd "$repo_root/web"
npm run test:e2e:share-target -- --url "$base"
