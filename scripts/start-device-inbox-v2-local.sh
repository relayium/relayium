#!/bin/sh
set -eu

repo=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
artifact_root=${1:?usage: start-device-inbox-v2-local.sh /absolute/artifact/root}
origin=http://127.0.0.1:18080

case "$artifact_root" in /*) ;; *) printf '%s\n' "artifact root must be absolute" >&2; exit 2 ;; esac
marker="$artifact_root/.relayium-engineering-artifact-root"
test -f "$marker" && test "$(cat "$marker")" = "relayium-engineering-artifacts-v1" || {
  printf '%s\n' "not a Relayium engineering artifact root" >&2; exit 2;
}
state="$artifact_root/local-server"
mkdir -p "$state/blobs"
printf '%s\n' "relayium-local-v2-state-v1" > "$state/.relayium-local-v2-state"

if [ ! -f "$repo/web/dist/index.html" ]; then
  printf '%s\n' "web/dist is missing; run 'cd web && npm run build' once" >&2
  exit 2
fi

cd "$repo/server"
go run ./cmd/relayium-local-bootstrap -state-root "$state"
printf '%s\n' "Relayium Device Inbox v2 local server: $origin"
printf '%s\n' "Login: engineering@relayium.local / relayium-local-v2"
exec go run . \
  -addr 127.0.0.1:18080 \
  -base-url "$origin" \
  -static "$repo/web/dist" \
  -db "$state/relayium.db" \
  -blob-dir "$state/blobs" \
  -release-check=false \
  -mail-transport dev-log-links \
  -enable-google=false \
  -enable-apple=false \
  -enable-magic=false \
  -turn-urls '' \
  -turn-relays ''
