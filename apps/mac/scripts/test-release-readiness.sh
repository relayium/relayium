#!/bin/bash

set -Eeuo pipefail

script_dir="$(cd "$(dirname "$0")" && pwd -P)"
repo_root="$(cd "$script_dir/../../.." && pwd -P)"
checker="$script_dir/check-release-readiness.mjs"
readiness="$repo_root/apps/mac/release-readiness.json"
work_dir="$(mktemp -d "${TMPDIR:-/tmp}/relayium-release-readiness.XXXXXX")"
trap 'rm -rf "$work_dir"' EXIT INT TERM

node "$checker" "$readiness"

if node "$checker" --require-approved "$readiness" \
  >"$work_dir/blocked.stdout" 2>"$work_dir/blocked.stderr"; then
  echo "error: current blocked release was accepted" >&2
  exit 1
fi
grep -Fq "macOS release is not approved" "$work_dir/blocked.stderr"

approved="$work_dir/approved.json"
node -e '
  const fs = require("fs");
  const value = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  value.approved = true;
  for (const item of value.capabilities) item.implemented = true;
  fs.writeFileSync(process.argv[2], JSON.stringify(value));
' "$readiness" "$approved"
node "$checker" --require-approved "$approved"

inconsistent="$work_dir/inconsistent.json"
node -e '
  const fs = require("fs");
  const value = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  value.approved = true;
  fs.writeFileSync(process.argv[2], JSON.stringify(value));
' "$readiness" "$inconsistent"
if node "$checker" "$inconsistent" \
  >"$work_dir/inconsistent.stdout" 2>"$work_dir/inconsistent.stderr"; then
  echo "error: approved release with blockers was accepted" >&2
  exit 1
fi
grep -Fq "approved release still has blockers" "$work_dir/inconsistent.stderr"

echo "release-readiness tests passed"
