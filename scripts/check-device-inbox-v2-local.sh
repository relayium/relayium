#!/bin/sh
set -eu

origin=http://127.0.0.1:18080
tmp=$(mktemp -d "${TMPDIR:-/tmp}/relayium-local-check.XXXXXX")
trap 'rm -rf "$tmp"' EXIT HUP INT TERM
credentials='{"email":"engineering@relayium.local","password":"relayium-local-v2"}'

curl -fsS -c "$tmp/cookies" -H 'Content-Type: application/json' \
  -d "$credentials" "$origin/api/auth/password/login" > "$tmp/web.json"
curl -fsS -b "$tmp/cookies" "$origin/api/me" > "$tmp/me.json"

for name in 'Engineering Mac' 'Engineering Browser Device'; do
  body=$(printf '{"email":"engineering@relayium.local","password":"relayium-local-v2","deviceName":"%s"}' "$name")
  file=$(printf '%s' "$name" | tr ' ' '-')
  curl -fsS -H 'Content-Type: application/json' -d "$body" \
    "$origin/api/auth/native/login" > "$tmp/$file.json"
done

token=$(node -e 'const x=require(process.argv[1]); if(!x.token) process.exit(1); process.stdout.write(x.token)' "$tmp/Engineering-Mac.json")
curl -fsS -H "Authorization: Bearer $token" "$origin/api/devices" > "$tmp/devices.json"
node - "$tmp/me.json" "$tmp/devices.json" <<'NODE'
const fs = require('fs');
const me = JSON.parse(fs.readFileSync(process.argv[2]));
const devices = JSON.parse(fs.readFileSync(process.argv[3]));
if (me.email !== 'engineering@relayium.local') throw new Error('browser account mismatch');
const list = Array.isArray(devices) ? devices : devices.devices;
for (const name of ['Engineering Mac', 'Engineering Browser Device']) {
  if (!list.some(device => device.name === name)) throw new Error(`missing device: ${name}`);
}
console.log(`local auth ready: ${me.email}; ${list.length} registered devices`);
NODE
