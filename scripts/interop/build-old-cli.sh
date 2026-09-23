#!/usr/bin/env bash
#
# **Build the released CLI the old-version pair cells talk to.**
#
#   scripts/interop/build-old-cli.sh <output path without extension>
#
# Prints the absolute path of the built binary (with the platform's executable
# suffix) on stdout, and nothing else. A hosted checkout is a one-commit shallow
# clone, so `ldOldCLI` in server/cmd/relayium/linkdev_test.go cannot find the
# old commit and SKIPS every old-version pair; this fetches exactly that commit,
# builds its `cmd/relayium` from `git archive` (no worktree, the checkout is not
# touched), and the caller exports RELAYIUM_OLD_CLI to it.
#
# The commit is not a second copy of the test's constant: it is READ from
# `ldOldCommit` in linkdev_test.go and resolved to a full SHA against origin,
# so the lane cannot silently test a different binary than the tests name.
set -Eeuo pipefail

out="${1:?usage: build-old-cli.sh <output path without extension>}"
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$here/../.." && pwd)"

short="$(sed -n 's/^const ldOldCommit = "\([0-9a-f]\{7,40\}\)"$/\1/p' "$repo/server/cmd/relayium/linkdev_test.go")"
[ -n "$short" ] || { echo "::error::ldOldCommit not found in server/cmd/relayium/linkdev_test.go" >&2; exit 1; }

if ! git -C "$repo" cat-file -e "$short^{commit}" 2>/dev/null; then
  # The short SHA cannot be fetched by itself; ask origin for the refs that
  # contain history and deepen until it appears. `main` carries it.
  git -C "$repo" fetch --no-tags --quiet --depth=1 origin main >&2 || true
  git -C "$repo" fetch --no-tags --quiet --deepen=400 origin main >&2 || true
  git -C "$repo" cat-file -e "$short^{commit}" 2>/dev/null \
    || { echo "::error::$short is not reachable from origin/main within 400 commits" >&2; exit 1; }
fi
full="$(git -C "$repo" rev-parse "$short^{commit}")"
echo "old CLI commit: $full" >&2

work="$(mktemp -d)"
git -C "$repo" archive --format=tar "$full" server | tar -x -C "$work"
exe="$(go env GOEXE)"
mkdir -p "$(dirname "$out")"
# Absolute BEFORE the build `cd`s into the archive.
bin="$(cd "$(dirname "$out")" && pwd)/$(basename "$out")$exe"
( cd "$work/server" && CGO_ENABLED=0 GOFLAGS=-mod=readonly go build -o "$bin" ./cmd/relayium ) >&2
rm -rf "$work"

# The same guard ldOldCLI applies to a binary it builds itself: the old CLI has
# no hidden `__link` and must refuse it as an unknown command. A binary that
# knows it is the NEW CLI, and a matrix run against it proves nothing.
set +e
probe="$("$bin" __link 2>&1)"
rc=$?
set -e
if [ "$rc" -ne 2 ] || ! printf '%s' "$probe" | grep -q "unknown command"; then
  echo "::error::the binary built from $full knows __link (exit $rc): $probe" >&2
  exit 1
fi
abs="$bin"
# Git Bash on Windows answers /d/a/...; the Go test execs it natively, which
# needs D:\a\...
if command -v cygpath >/dev/null 2>&1; then abs="$(cygpath -w "$abs")"; fi
printf '%s\n' "$abs"
